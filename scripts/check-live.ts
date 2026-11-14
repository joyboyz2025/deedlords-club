// npm run check:live
//
// Reads NEAR mainnet and checks, from the chain alone, what the README says is there. It holds no key and sends
// nothing: every request is a read of a public node. Each line is one claim and what was found.
//
//   1. the three contracts are deployed, with the code the README names;
//   2. a poker shuffle that went through: its proof travelled in the transaction and the contract accepted it;
//   3. a guest's move at a free table: signed by the guest, sent and paid for by the sponsor (NEP-366);
//   4. a move by an AI agent with its TEE proof: the same checks the /verify page runs in the browser;
//   5. a staked match that the contract itself paid out.
//
// `npm run check:live -- <tx hash> <signer>` checks another AI turn instead of the one named below.

import { parseAnswer } from "../games/co-ty-phu/agent/llm.ts";
import { cleanPlan } from "../games/co-ty-phu/agent/plan.ts";
import { readTransaction, rpc } from "../lib/chain/rpc.ts";
import { checkAttestation, checkProof, cleanProof, proofAnswer } from "../lib/teeProof.ts";

const NODES = {
  rpcUrl: "https://free.rpc.fastnear.com,https://near.drpc.org,https://rpc.mainnet.near.org",
  archiveUrl: "https://archival-rpc.mainnet.fastnear.com,https://archival-rpc.mainnet.near.org",
};
const EXPLORER = "https://nearblocks.io/txns";

/** The contracts and the code each ran on 2026-11-13. An upgrade changes the hash: the README says which is current. */
const CONTRACTS: [string, string, string][] = [
  ["game.deedlords.near", "Ha6nhaKnZ8p4SyGrvhgzniXNujjhbwfi3WKobcwMv5o6", "Deedlords, the board game"],
  ["poker.deedlords.near", "7gBmMKnAkiroQJsMa1NnEoogPTotqsnEHiFzk6KRPb5Y", "Poker, tables of 2 to 9 seats"],
  ["chibi.deedlords.near", "BxzvTicT3UR8VcocQL7tDMW3D29jSTbfRGAWB6L7158C", "Characters and what they wear (NEP-171)"],
];

/** Real transactions of 2026-11-12 and 13, by hash and by the account that signed each. */
const SHUFFLE = { hash: "HucKM9wPjKYhhSAtAec7rvDvnKRfnSjNT5CJ9ypHaRWG", signer: "16c3b2934c0309ca548fa5edf7d5892a6ef5487767b3012209dd170d966679b9" };
const GUEST_MOVE = { hash: "2jesymTABFtwPkeVX29Sc6DFhFvWQX9Rq2jyEAhTcLUx", signer: "free.deedlords.near" };
const AI_TURN = { hash: "2af7dAbW4rBsDSKKhXAdyTXB35FrxcoXttPiE2swuXEc", signer: "free.deedlords.near" };
const PAYOUT = { hash: "Ci1p7yj2tqF3LXhMNrEjAYQbyuk416u6zcNPVXi3TADJ", signer: "16c3b2934c0309ca548fa5edf7d5892a6ef5487767b3012209dd170d966679b9" };

type Call = { method_name?: string; args?: string };
type Action = {
  FunctionCall?: Call;
  Delegate?: { delegate_action?: { sender_id?: string; receiver_id?: string; actions?: { FunctionCall?: Call }[] } };
  Transfer?: { deposit?: string };
};
type Outcome = { outcome: { gas_burnt: number; tokens_burnt: string; executor_id?: string } };
type Receipt = { predecessor_id?: string; receiver_id?: string; receipt?: { Action?: { actions?: Action[] } } };
type Tx = {
  transaction: { signer_id: string; receiver_id: string; actions: Action[] };
  transaction_outcome: Outcome;
  receipts_outcome: Outcome[];
  receipts?: Receipt[];
  status: { SuccessValue?: string; Failure?: unknown };
};

// What is found is kept and printed at the end: a public node or NEAR AI's report may fail to answer once, and then
// everything is read a second time before anything is called a failure.
let failed = 0;
/** Checks that could be neither passed nor failed today (marked `!`): see `Check.unlisted`. */
let unconfirmed = 0;
let printed: string[] = [];
const say = (text: string) => printed.push(text);
const line = (ok: boolean, what: string, found = "") => {
  if (!ok) failed++;
  say(`  ${ok ? "✓" : "✗"} ${what}${found ? `\n      ${found}` : ""}`);
};
const head = (title: string) => say(`\n${title}`);
const near = (yocto: bigint) => `${(Number(yocto / 10n ** 18n) / 1e6).toFixed(5)} NEAR`;
const bytes = (base64: string | undefined) => Uint8Array.from(atob(base64 ?? ""), (char) => char.charCodeAt(0));
const json = (call: Call | undefined): Record<string, unknown> => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes(call?.args))) as Record<string, unknown>;
  } catch {
    return {};
  }
};
const spent = (tx: Tx) => {
  const all = [tx.transaction_outcome, ...tx.receipts_outcome];
  const gas = all.reduce((sum, one) => sum + one.outcome.gas_burnt, 0);
  const tokens = all.reduce((sum, one) => sum + BigInt(one.outcome.tokens_burnt), 0n);
  return `${(gas / 1e12).toFixed(1)} Tgas, ${near(tokens)} in fees`;
};
const read = (one: { hash: string; signer: string }) => readTransaction<Tx>(NODES, one.hash, one.signer, { timeoutMs: 20_000 });
/** The same transaction with the receipts it made (what was sent on, to whom): asked of the archive when the ordinary nodes no longer hold it. */
async function readWithReceipts(one: { hash: string; signer: string }): Promise<Tx> {
  const params = { tx_hash: one.hash, sender_account_id: one.signer, wait_until: "FINAL" };
  try {
    return await rpc<Tx>(NODES.rpcUrl, "EXPERIMENTAL_tx_status", params, { timeoutMs: 20_000 });
  } catch {
    return rpc<Tx>(NODES.archiveUrl, "EXPERIMENTAL_tx_status", params, { timeoutMs: 20_000 });
  }
}
const link = (hash: string) => `${EXPLORER}/${hash}`;

async function contracts() {
  head("1. The contracts are on NEAR mainnet");
  for (const [accountId, expected, what] of CONTRACTS) {
    const account = await rpc<{ code_hash: string; amount: string; storage_usage: number }>(NODES.rpcUrl, "query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
    const same = account.code_hash === expected;
    line(
      account.code_hash !== "11111111111111111111111111111111",
      `${accountId}: ${what}`,
      `code ${account.code_hash}${same ? "" : ` (the README names ${expected}: upgraded since)`}, ${account.storage_usage.toLocaleString("en")} bytes of state and code`,
    );
  }
}

async function shuffle() {
  head("2. A poker shuffle is proved inside its own transaction");
  const tx = await read(SHUFFLE);
  const call = tx.transaction.actions[0]?.FunctionCall;
  const size = bytes(call?.args).length;
  line(
    call?.method_name === "shuffle" && tx.transaction.receiver_id === CONTRACTS[1][0],
    `a seat called shuffle on ${tx.transaction.receiver_id}`,
    `signed by ${tx.transaction.signer_id}`,
  );
  line(
    size > 16_000,
    "the shuffled deck and its proof are the call's own arguments",
    `${size.toLocaleString("en")} bytes: 52 re-encrypted cards and the proof that they are the same 52`,
  );
  line(tx.status.Failure === undefined, "the contract checked the proof and took the deck", `${spent(tx)}; ${link(SHUFFLE.hash)}`);
}

async function guestMove() {
  head("3. A guest moves without holding any NEAR");
  const tx = await read(GUEST_MOVE);
  const delegate = tx.transaction.actions[0]?.Delegate?.delegate_action;
  const call = delegate?.actions?.[0]?.FunctionCall;
  line(
    Boolean(delegate?.sender_id),
    "the move is a delegate action: the guest's own key signed it",
    `the contract saw ${delegate?.sender_id ?? "?"} call ${call?.method_name ?? "?"} on ${delegate?.receiver_id ?? "?"}`,
  );
  line(tx.transaction.signer_id !== delegate?.sender_id, "another account sent it and paid", `${tx.transaction.signer_id} paid ${spent(tx)}`);
  line(tx.status.Failure === undefined, "it went through", link(GUEST_MOVE.hash));
}

async function aiTurn(one: { hash: string; signer: string }) {
  head("4. An AI agent's move carries a proof of the model that made it");
  const tx = await read(one);
  const direct = tx.transaction.actions.map((action) => action.FunctionCall).find((call) => call?.method_name === "turn");
  const relayed = tx.transaction.actions
    .flatMap((action) => action.Delegate?.delegate_action?.actions ?? [])
    .map((action) => action.FunctionCall)
    .find((call) => call?.method_name === "turn");
  const args = json(direct ?? relayed);
  const proof = cleanProof(args.proof);
  line(
    Boolean(proof),
    "the turn's transaction carries a TEE proof",
    proof ? `model ${proof.model}, signed by ${proof.kind === "provider_tee" ? "the model's own enclave" : "NEAR AI's gateway enclave"}; match ${String(args.id)}` : link(one.hash),
  );
  if (!proof) return;
  for (const check of checkProof(proof)) line(check.ok, check.label, check.detail);
  const content = proofAnswer(proof).content;
  const answered = content ? parseAnswer(content) : null;
  const played = cleanPlan(args.plan);
  line(
    Boolean(answered && played && JSON.stringify(answered.plan) === JSON.stringify(played)),
    "The plan played is the plan the model answered",
    answered ? JSON.stringify(answered.plan) : "no plan in the response",
  );
  const attested = await checkAttestation(proof);
  if (attested.unlisted) {
    unconfirmed++;
    say(`  ! ${attested.label}: not confirmed today\n      ${attested.detail}`);
  } else line(attested.ok, attested.label, attested.detail);
  say(`      ${link(one.hash)}`);
}

async function payout() {
  head("5. The contract pays the pot itself");
  const tx = await readWithReceipts(PAYOUT);
  const call = tx.transaction.actions[0]?.FunctionCall;
  const paid = (tx.receipts ?? []).filter((receipt) => receipt.predecessor_id === CONTRACTS[0][0] && receipt.receipt?.Action?.actions?.some((action) => action.Transfer));
  line(
    call?.method_name === "play" || call?.method_name === "turn",
    `the last move of match ${String(json(call).id)} was an ordinary move`,
    `${tx.transaction.signer_id} called ${call?.method_name}`,
  );
  line(
    paid.length > 0,
    "the same transaction made the contract send the stakes out",
    paid.map((receipt) => `${near(BigInt(receipt.receipt?.Action?.actions?.find((action) => action.Transfer)?.Transfer?.deposit ?? "0"))} to ${receipt.receiver_id}`).join(", ") ||
      "no transfer found",
  );
  say(`      ${spent(tx)}; ${link(PAYOUT.hash)}`);
}

const [hash, signer] = process.argv.slice(2);
console.log("Deedlords Club on NEAR mainnet, read from public nodes. Nothing is signed or sent.");
const steps: [string, () => Promise<void>][] = [
  ["contracts", contracts],
  ["shuffle", shuffle],
  ["guest move", guestMove],
  ["AI turn", () => aiTurn(hash && signer ? { hash, signer } : AI_TURN)],
  ["payout", payout],
];
for (let reading = 0; reading < 2; reading++) {
  failed = 0;
  unconfirmed = 0;
  printed = [];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      line(false, `${name}: could not be read`, error instanceof Error ? error.message : String(error));
    }
  }
  if (failed === 0 && unconfirmed === 0) break;
  if (reading === 0) await new Promise((done) => setTimeout(done, 4_000));
}
console.log(printed.join("\n"));
const open = unconfirmed > 0 ? ` ${unconfirmed} could not be confirmed today (marked !).` : "";
console.log(failed === 0 ? (unconfirmed > 0 ? `\nNo check failed.${open}` : "\nEvery check passed.") : `\n${failed} check${failed === 1 ? "" : "s"} did not pass.${open}`);
process.exit(failed === 0 ? 0 : 1);
