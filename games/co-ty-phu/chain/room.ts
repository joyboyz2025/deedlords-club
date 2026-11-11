// One on-chain match, kept in step with the contract. No React and no network of its own: it is handed something that
// reads the contract and, for a seated player, something that calls it, so tests can stand a fake chain behind it.
//
// Reading: `get_match` is polled. Answers can come from a node one block behind, so an answer older than the newest one
// seen is dropped.
// Moving: an action that needs no dice is applied here first with the reference engine and shown at once, then sent;
// actions made while a transaction is on its way go out together in the next one. A roll is only sent: until it lands
// nothing else can be played (`busy`). If the contract refuses anything, what was shown ahead of the chain is dropped.

import { currentPlayer, type Game } from "../engine.ts";
import type { Plan } from "../agent/plan.ts";
import type { ClientMessage } from "../protocol.ts";
import type { View } from "../view.ts";
import { applyAction, chainView, deadlineMs, diceAllowed, needsDice, seatOf, settledGame, toAction, toGame } from "./adapt.ts";
import { describeCall, type MoveTx } from "./ledger.ts";
import type { ChainMatch, ChainResult, ContractAction, PlayOutcome } from "./types.ts";

export type Reader = { view<T>(method: string, args?: unknown): Promise<T> };
export type Caller = { readonly accountId: string; call(method: string, args: unknown): Promise<{ value: unknown; hash?: string }> };

export type RoomLink = "connecting" | "online" | "offline";
/** `no-match`: the contract has no such match and no result for it. `abandoned`: it was closed in the lobby and refunded. */
export type RoomError = "no-match" | "abandoned";

export type RoomState = {
  /** The contract's last answer; after the payout, the last one before it. */
  match: ChainMatch | null;
  /** What the viewer sees: the chain's state plus their own moves still on their way. */
  view: View | null;
  /** Set once the match is settled. */
  result: ChainResult | null;
  /** The seat the viewer moves for, `null` for a watcher. */
  seat: number | null;
  link: RoomLink;
  error: RoomError | null;
  /** A move that needs the chain's dice is on its way. */
  busy: boolean;
  /** Why the last move did not go through. */
  notice: string | null;
  /** The transactions this viewer sent for the match since the page opened, oldest first. */
  sent: MoveTx[];
  /** When this state was made, for countdowns. */
  at: number;
};

export type RoomOptions = {
  id: string;
  reader: Reader;
  /** `null`: watch only. */
  caller: Caller | null;
  pollMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Polling rests while this says no (a hidden tab). */
  isVisible?: () => boolean;
};

/** `play` takes at most this many actions. */
const MAX_ACTIONS = 32;
/** After a transaction: how often and how far apart the match is re-read until the move shows. */
const RESYNC_TRIES = 15;
const RESYNC_WAIT_MS = 200;
/** A seated player forces a turn this long after its deadline, and again this often while it stays overdue. */
const TIMEOUT_GRACE_MS = 1_500;
const TIMEOUT_RETRY_MS = 1_200;
const OFFLINE_AFTER = 2;

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class ChainRoom {
  private readonly id: string;
  private readonly reader: Reader;
  private readonly caller: Caller | null;
  private readonly accountId: string | null;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly isVisible: () => boolean;

  private chain: ChainMatch | null = null;
  private chainJson = "";
  /** The chain's game with the viewer's unconfirmed moves on top, `null` when there are none. */
  private local: Game | null = null;
  /** Actions not yet sent. Those of the transaction on its way are no longer here. */
  private queue: ContractAction[] = [];
  private dicePending = false;
  /** The board to keep showing after the payout. */
  private final: Game | null = null;
  private result: ChainResult | null = null;
  private link: RoomLink = "connecting";
  private error: RoomError | null = null;
  private notice: string | null = null;
  private failures = 0;
  private nextTimeoutAt = 0;
  private sent: MoveTx[] = [];
  /** The transaction (and the re-read after it) in progress. One at a time. */
  private working: Promise<void> | null = null;
  private loop = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  private state: RoomState;

  constructor(options: RoomOptions) {
    this.id = options.id;
    this.reader = options.reader;
    this.caller = options.caller;
    this.accountId = options.caller?.accountId ?? null;
    this.pollMs = options.pollMs;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.isVisible = options.isVisible ?? (() => true);
    this.state = { match: null, view: null, result: null, seat: null, link: "connecting", error: null, busy: false, notice: null, sent: [], at: this.now() };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): RoomState => this.state;

  /** Starts polling. Safe to call again after `stop`. */
  start(): void {
    const loop = ++this.loop;
    void this.tick(loop);
  }

  stop(): void {
    this.loop += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** After `no-match`: look again (the match may have been created since). */
  readonly retry = (): void => {
    this.error = null;
    this.emit();
    this.start();
  };

  /** Reads the match now instead of at the next poll. */
  readonly refresh = async (): Promise<void> => {
    if (!this.working && !this.result && !this.error) await this.poll();
  };

  /** Resolves once no transaction is on its way and nothing waits to be sent. */
  async idle(): Promise<void> {
    while (this.working) await this.working;
  }

  /** A move from the screen. Ignored when it is not the viewer's to make; the rules are the engine's. */
  readonly send = (message: ClientMessage): void => {
    const action = toAction(message);
    const match = this.chain;
    if (!action || !match || !this.caller || this.result || this.dicePending || match.meta.status !== "playing") return;
    const seat = seatOf(match.meta, this.accountId);
    if (seat === null) return;
    const playerId = match.meta.seats[seat].player;
    const game = this.local ?? toGame(match);
    if (needsDice(game, action)) {
      if (!diceAllowed(game, playerId, action)) return;
      this.dicePending = true;
    } else {
      const next = structuredClone(game);
      if (!applyAction(next, playerId, action)) return;
      this.local = next;
    }
    this.queue.push(action);
    this.notice = null;
    this.emit();
    this.kick();
  };

  /**
   * A whole turn by plan, as an agent plays it: one `turn` transaction that rolls, applies the plan wherever the seat
   * lands and ends the turn. `false`: it cannot be sent now (not the viewer's turn, or moves of theirs are on their way).
   */
  readonly playTurn = (plan: Plan): boolean => {
    const match = this.chain;
    const caller = this.caller;
    if (!match || !caller || this.result || this.working || this.dicePending || this.queue.length > 0 || match.meta.status !== "playing") return false;
    const seat = seatOf(match.meta, this.accountId);
    if (seat === null || match.meta.current_seat !== seat) return false;
    this.dicePending = true;
    this.notice = null;
    this.emit();
    this.occupy(async () => {
      let problem: string | null = null;
      try {
        await this.transact(caller, "turn", { id: this.id, seat, plan });
      } catch (error) {
        problem = text(error);
      }
      if (problem !== null) this.notice = problem;
      await this.resync(problem === null);
    });
    return true;
  };

  private async tick(loop: number): Promise<void> {
    // A settled match no longer changes; after an error `retry` starts the polling again.
    if (loop !== this.loop || this.result || this.error) return;
    if (!this.working && this.isVisible()) await this.poll();
    if (loop !== this.loop || this.result || this.error) return;
    this.timer = setTimeout(() => void this.tick(loop), this.pollMs);
  }

  private async poll(): Promise<void> {
    let match: ChainMatch | null;
    try {
      match = await this.reader.view<ChainMatch | null>("get_match", { id: this.id });
    } catch {
      this.failures += 1;
      if (this.failures >= OFFLINE_AFTER && this.link !== "offline") {
        this.link = "offline";
        this.emit();
      }
      return;
    }
    // A move started while this read was on its way: the read that follows the move is the one that counts.
    if (this.working) return;
    this.failures = 0;
    const wasOnline = this.link === "online";
    this.link = "online";
    if (match === null) return this.gone();
    if (this.accept(match)) {
      this.rebase();
      this.emit();
    } else if (!wasOnline) this.emit();
    this.forceOverdueTurn();
  }

  /** Takes the answer unless it is the one already held or an older one. */
  private accept(match: ChainMatch): boolean {
    const json = JSON.stringify(match);
    if (json === this.chainJson) return false;
    if (this.chain && BigInt(match.meta.last_activity) < BigInt(this.chain.meta.last_activity)) return false;
    this.chain = match;
    this.chainJson = json;
    return true;
  }

  /** `get_match` answered `null`: settled (there is a result), abandoned in the lobby, or never there. */
  private async gone(): Promise<void> {
    let result: ChainResult | null;
    try {
      result = await this.reader.view<ChainResult | null>("get_result", { id: this.id });
    } catch {
      return; // asked again at the next poll
    }
    if (result) {
      this.result = result;
      if (this.chain) this.final = settledGame(this.local ?? toGame(this.chain), this.chain.meta, result);
    } else {
      this.error = this.chain ? "abandoned" : "no-match";
    }
    this.local = null;
    this.queue = [];
    this.dicePending = false;
    this.emit();
  }

  /** Calls the contract as the viewer and notes the transaction for the match's list of them. */
  private async transact(caller: Caller, method: string, args: unknown): Promise<{ value: unknown }> {
    const outcome = await caller.call(method, args);
    if (outcome.hash) this.sent = [...this.sent, { hash: outcome.hash, signer: caller.accountId, method, what: describeCall(method, args), atMs: this.now(), ok: true }];
    return outcome;
  }

  private kick(): void {
    if (!this.working && this.queue.length > 0) this.occupy(() => this.pump());
  }

  private occupy(job: () => Promise<void>): void {
    this.working = job()
      .catch((error) => {
        this.notice = text(error);
      })
      .finally(() => {
        this.working = null;
        this.emit();
        this.kick();
      });
  }

  /** Sends what is queued, one transaction after the other, re-reading the match after each. */
  private async pump(): Promise<void> {
    while (this.queue.length > 0 && !this.result) {
      const match = this.chain;
      const seat = match && seatOf(match.meta, this.accountId);
      if (!this.caller || !match || seat === null) {
        this.queue = [];
        break;
      }
      const actions = this.queue.splice(0, MAX_ACTIONS);
      let problem: string | null = null;
      try {
        const outcome = await this.transact(this.caller, "play", { id: this.id, seat, actions });
        const rejected = (outcome.value as PlayOutcome | null)?.rejected;
        if (rejected) problem = `Move refused: ${rejected.error}`;
      } catch (error) {
        problem = text(error);
      }
      if (problem !== null) {
        // Everything shown ahead of the chain rested on this transaction.
        this.queue = [];
        this.notice = problem;
      }
      await this.resync(problem === null);
      this.emit();
    }
  }

  /**
   * Reads the match after a transaction. A node may still answer from the block before, so when the move went through
   * the read is repeated until the match has changed. Then what is still queued is replayed on the new state.
   */
  private async resync(expectChange: boolean): Promise<void> {
    for (let i = 0; i < RESYNC_TRIES; i++) {
      let match: ChainMatch | null;
      try {
        match = await this.reader.view<ChainMatch | null>("get_match", { id: this.id });
      } catch {
        await this.sleep(RESYNC_WAIT_MS);
        continue;
      }
      if (match === null) return this.gone();
      if (this.accept(match) || !expectChange) break;
      await this.sleep(RESYNC_WAIT_MS);
    }
    this.rebase();
  }

  /** Rebuilds the viewer's unconfirmed moves on top of the chain's state. A move the rules no longer allow is dropped with all that follow. */
  private rebase(): void {
    const match = this.chain;
    const queued = this.queue;
    this.local = null;
    this.dicePending = false;
    this.queue = [];
    const seat = match && seatOf(match.meta, this.accountId);
    if (!match || seat === null || match.meta.status !== "playing" || queued.length === 0) return;
    const playerId = match.meta.seats[seat].player;
    const game = toGame(match);
    for (const action of queued) {
      if (needsDice(game, action)) {
        // Nothing can follow a move that needs dice: `send` takes no more until it lands.
        if (diceAllowed(game, playerId, action)) {
          this.queue.push(action);
          this.dicePending = true;
        }
        break;
      }
      if (!applyAction(game, playerId, action)) break;
      this.queue.push(action);
      this.local = game;
    }
  }

  /** The turn's deadline has passed: any seated player may ask the contract to move for whoever is late (`timeout`). */
  private forceOverdueTurn(): void {
    const match = this.chain;
    const caller = this.caller;
    if (!match || !caller || this.working || this.queue.length > 0 || this.result || seatOf(match.meta, this.accountId) === null) return;
    const deadline = deadlineMs(match.meta);
    const now = this.now();
    if (deadline === null || now < deadline + TIMEOUT_GRACE_MS || now < this.nextTimeoutAt) return;
    this.nextTimeoutAt = now + TIMEOUT_RETRY_MS;
    this.occupy(async () => {
      // Refused when somebody else was first, or when the chain's clock is behind this machine's: tried again later.
      await this.transact(caller, "timeout", { id: this.id }).catch(() => undefined);
      await this.resync(false);
    });
  }

  private emit(): void {
    const now = this.now();
    const match = this.chain;
    let view: View | null = null;
    if (match) {
      const base = toGame(match);
      const game = this.final ?? this.local ?? base;
      // Once the viewer's own moves have passed the turn on, the deadline the chain reported belongs to the turn before.
      const sameTurn = !this.final && currentPlayer(game)?.id === currentPlayer(base)?.id;
      view = chainView(game, match.meta, this.accountId, now, sameTurn ? deadlineMs(match.meta) : null);
    }
    this.state = {
      match,
      view,
      result: this.result,
      seat: match ? seatOf(match.meta, this.accountId) : null,
      link: this.link,
      error: this.error,
      busy: this.dicePending,
      notice: this.notice,
      sent: this.sent,
      at: now,
    };
    for (const listener of this.listeners) listener();
  }
}
