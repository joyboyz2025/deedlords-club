// The free side of the chibi characters. GET: the contract and the account that pays here (`minter: null`: none).
// POST a signed request (games/chibi/proof.ts): make a character, take a basic item, or dress up. The sponsor, which
// is the contract's minter, makes the call for the account: the account needs no NEAR, and the contract pays the
// storage out of its free pool. Boxes are not here: an account buys them with its own NEAR, signing itself.
//
// The request must be signed by a key of the account: the key it is named after (a guest's, an EVM wallet's), or any
// key the account holds on chain (the key a Google sign-in or a NEAR wallet granted this browser for the game).

import { clientKey, intEnv, rateLimiter } from "@/games/co-ty-phu/agent/rateLimit";
import { jsonAnswer } from "@/games/co-ty-phu/chain/freeDesk";
import { minterCall, openRequest, Refused, type OpenedRequest } from "@/games/chibi/proof";
import { isContractFailure } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { chainClient } from "@/lib/chain/shared";
import { sponsor } from "@/lib/chain/sponsor";
import { jsonArgs } from "@/lib/chain/transaction";

export const dynamic = "force-dynamic";

const env = process.env;
const TEN_MINUTES = 10 * 60_000;
const HOUR = 60 * 60_000;
/** Making a character with every part chosen burns about 16 Tgas. */
const GAS = 60_000_000_000_000n;
const limits = {
  // A character costs the free pool about 0.05 NEAR, an item about 0.007: few per address.
  createPerIp: rateLimiter(intEnv(env.DEEDLORDS_CHIBI_CREATE_IP_LIMIT, 4), TEN_MINUTES),
  createGlobal: rateLimiter(intEnv(env.DEEDLORDS_CHIBI_CREATE_GLOBAL_LIMIT, 60), HOUR),
  callPerIp: rateLimiter(intEnv(env.DEEDLORDS_CHIBI_IP_LIMIT, 60), TEN_MINUTES),
  callPerAccount: rateLimiter(intEnv(env.DEEDLORDS_CHIBI_IP_LIMIT, 60), TEN_MINUTES),
  callGlobal: rateLimiter(intEnv(env.DEEDLORDS_CHIBI_GLOBAL_LIMIT, 1200), HOUR),
};
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
const where = { contract: CHAIN.chibiId, network: CHAIN.network };

// A key an account holds stays held: a yes is remembered for a while, a no is asked again.
const heldKeys = new Map<string, number>();

async function keyIsHeld(opened: OpenedRequest): Promise<boolean> {
  if (opened.ownKey) return true;
  const name = `${opened.accountId}:${Array.from(opened.publicKey).join(",")}`;
  if ((heldKeys.get(name) ?? 0) > Date.now()) return true;
  if ((await chainClient.accessKeyNonce(opened.accountId, opened.publicKey)) === null) return false;
  if (heldKeys.size > 2_000) for (const [key, until] of heldKeys) if (until <= Date.now()) heldKeys.delete(key);
  heldKeys.set(name, Date.now() + 30 * 60_000);
  return true;
}

export function GET(): Response {
  return jsonAnswer(200, { contract: CHAIN.chibiId, minter: sponsor()?.accountId ?? null, network: CHAIN.network });
}

export async function POST(request: Request): Promise<Response> {
  const paying = sponsor();
  if (!paying) return jsonAnswer(503, { error: "nobody pays for free characters on this server" });
  let opened: OpenedRequest;
  try {
    opened = openRequest(await request.json(), where);
  } catch (error) {
    return jsonAnswer(error instanceof Refused ? 403 : 400, { error: error instanceof Refused ? error.message : "send JSON: a signed request" });
  }
  const ip = clientKey(request);
  const creating = opened.request.action === "create";
  if (creating && (!limits.createPerIp.allow(ip) || !limits.createGlobal.allow("*"))) return jsonAnswer(429, { error: "too many new characters from here: wait a few minutes" });
  if (!limits.callPerIp.allow(ip) || !limits.callPerAccount.allow(opened.accountId) || !limits.callGlobal.allow("*"))
    return jsonAnswer(429, { error: "too many changes from here in a short time: wait a few minutes" });
  try {
    if (!(await keyIsHeld(opened))) return jsonAnswer(403, { error: "this key is not one of the account's" });
  } catch {
    return jsonAnswer(502, { error: `cannot reach ${CHAIN.network}` });
  }
  const { method, args } = minterCall(opened);
  try {
    const outcome = await paying.session.sendTo(CHAIN.chibiId, [{ method, args: jsonArgs(args), gas: GAS, deposit: 0n }]);
    return jsonAnswer(200, { hash: outcome.hash, value: outcome.value });
  } catch (error) {
    // The contract said no (a name taken, an item already taken): the person can do something about it.
    if (isContractFailure(error)) return jsonAnswer(409, { error: error.message.replace(/^.*Smart contract panicked: /, ""), hash: error.hash });
    return jsonAnswer(502, { error: `the sponsor could not send it: ${text(error)}` });
  }
}
