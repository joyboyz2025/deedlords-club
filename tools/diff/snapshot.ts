// The snapshot of docs/ENGINE-RULES.md §8: the part of the game state both engines must agree on after every step.
// Lobby, time limit, trades, names, looks and the text log are left out (they are TS-only).

import type { Deck } from "../../games/co-ty-phu/board.ts";
import type { Game, Owned, Payee, Phase, Result, Stage, TicketState } from "../../games/co-ty-phu/engine.ts";

export type SnapshotPlayer = {
  id: string;
  cash: number;
  position: number;
  jail: number | null;
  freeCards: Deck[];
  bankrupt: boolean;
  outAt: number | null;
};

export type Snapshot = {
  phase: Phase;
  order: string[];
  turn: number;
  stage: Stage;
  dice: [number, number] | null;
  doubles: number;
  again: boolean;
  round: number;
  props: Record<string, Owned>;
  debt: Payee[] | null;
  pendingMove: number | null;
  card: { deck: Deck; index: number } | null;
  buildAt: number | null;
  builtThisTurn: number[];
  minted: number;
  rolls: number;
  result: Result | null;
  /** Seating order (the order of `game.players`), not turn order. */
  players: SnapshotPlayer[];
  /** Only in a game with tickets (ENGINE-RULES §10.2). */
  tickets?: TicketState;
};

/** A deep copy, so later moves never change a snapshot already taken. */
export function snapshot(game: Game): Snapshot {
  const props: Record<string, Owned> = {};
  for (const key of Object.keys(game.props).map(Number).sort((a, b) => a - b)) {
    const { owner, houses, mortgaged } = game.props[key];
    props[String(key)] = { owner, houses, mortgaged };
  }
  return {
    phase: game.phase,
    order: [...game.order],
    turn: game.turn,
    stage: game.stage,
    dice: game.dice ? [game.dice[0], game.dice[1]] : null,
    doubles: game.doubles,
    again: game.again,
    round: game.round ?? 0,
    props,
    debt: game.debt ? game.debt.map(({ id, amount }) => ({ id, amount })) : null,
    pendingMove: game.pendingMove,
    card: game.card ? { deck: game.card.deck, index: game.card.index } : null,
    buildAt: game.buildAt ?? null,
    builtThisTurn: [...(game.builtThisTurn ?? [])],
    minted: game.minted,
    rolls: game.rolls,
    result: game.result ? { reason: game.result.reason, ranking: [...game.result.ranking] } : null,
    players: game.players.map((p) => ({
      id: p.id,
      cash: p.cash,
      position: p.position,
      jail: p.jail,
      freeCards: [...p.freeCards],
      bankrupt: p.bankrupt,
      outAt: p.outAt,
    })),
    ...(game.tickets ? { tickets: structuredClone(game.tickets) } : {}),
  };
}
