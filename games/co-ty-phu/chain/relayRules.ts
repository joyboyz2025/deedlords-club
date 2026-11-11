// What the sponsor agrees to send and pay for on a player's behalf. A relayer signs whatever passes here with its own
// money, so this is the whole fence: one call, to the game contract, to a method that moves a seat, with no deposit,
// from a game account, signed by a key of that account. Whether the match named is a free table is checked by the
// caller, against the chain; so is the key, when it is not the one the account is named after.
//
// The one other thing the sponsor pays for is a key grant: an account signed in through NEAR Auth giving this browser
// a key that can only make those same calls (`grantable`).

import { implicitAccountId } from "../../../lib/chain/evmKey.ts";
import type { DelegateAction, KeyGrant } from "../../../lib/chain/transaction.ts";
import { GRANT_METHODS, SESSION_ALLOWANCE } from "./calls.ts";

/** The calls of a seat: taking it, leaving it, handing it to a driver, moving it, and forcing a late turn. */
export const RELAY_METHODS = ["join", "leave", "set_driver", "play", "turn", "timeout"] as const;
/** The contract's floor for a move, and all a relayed call may attach. */
export const RELAY_MAX_GAS = 100_000_000_000_000n;
/** `play` takes at most 32 actions and a plan at most 80 squares: well under this. */
export const RELAY_MAX_ARGS = 4_096;
export const MATCH_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** The relayer says no, and why. Nothing was sent. */
export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

/**
 * The match and the method of a delegate action the sponsor may pay for. Throws `Refused` for any other.
 * `ownKey`: signed by the key the account is named after (a guest's, an EVM wallet's). Otherwise the caller must
 * check that the key is one the account granted for this contract (`ChainClient.functionCallKey`): the signature
 * only proves who holds the key, not that the account knows it.
 */
export function relayable(action: DelegateAction, contractId: string): { matchId: string; method: string; ownKey: boolean } {
  if (!/^[0-9a-f]{64}$/.test(action.senderId)) throw new Refused("only a game account plays for free");
  const ownKey = action.senderId === implicitAccountId(action.publicKey);
  if (action.receiverId !== contractId) throw new Refused(`only calls to ${contractId} are sent`);
  if (action.actions.length !== 1) throw new Refused("one call at a time");
  const call = action.actions[0];
  if (!(RELAY_METHODS as readonly string[]).includes(call.method)) throw new Refused(`${call.method} is not a seat's call`);
  if (call.deposit !== 0n) throw new Refused("a free table takes no deposit");
  if (call.gas > RELAY_MAX_GAS) throw new Refused("too much gas attached");
  if (call.args.length > RELAY_MAX_ARGS) throw new Refused("the call is too long");
  let id: unknown;
  try {
    id = (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(call.args)) as { id?: unknown } | null)?.id;
  } catch {
    throw new Refused("the call's arguments are not JSON");
  }
  if (typeof id !== "string" || !MATCH_ID.test(id)) throw new Refused("the call names no match");
  return { matchId: id, method: call.method, ownKey };
}

/**
 * A key grant the sponsor may have signed (by NEAR Auth) and sent: for the account named after the key that signs
 * it, a key that can call nothing but a seat's methods on the game contract, with a bounded allowance. Throws
 * `Refused` for any other: the sponsor is not a general-purpose way to get things signed.
 */
export function grantable(grant: KeyGrant, contractId: string): void {
  if (grant.accountId !== implicitAccountId(grant.accountKey)) throw new Refused("a key is granted by the account its signing key names");
  if (grant.contractId !== contractId) throw new Refused(`only keys for ${contractId} are granted`);
  if (grant.methods.length === 0 || grant.methods.some((method) => !(GRANT_METHODS as readonly string[]).includes(method)))
    throw new Refused("the key may only call a seat's methods");
  if (grant.allowance === null || grant.allowance > BigInt(SESSION_ALLOWANCE)) throw new Refused("the key's allowance is too large");
}
