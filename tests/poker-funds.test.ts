// A poker account kept beside a wallet or Google account (games/poker/pokerFunds.ts): what is moved to it for a seat
// with a stake, in one approval, and what goes back. The chain and the wallet here are fakes.

import assert from "node:assert/strict";
import { test } from "node:test";
import { KEPT_BACK, amountToMove, fundPoker, sendBack, type FundWith } from "../games/poker/pokerFunds.ts";

const near = (n: number) => BigInt(Math.round(n * 1000)) * 10n ** 21n;
const WALLET = { via: "wallet", accountId: "alice.near" } as never;
const POKER = "20adb3f95a90e1d90c6bcf17ed8c49eb7cc54483489b36a50f1f2525b1a70686";

test("what moves to the poker account is the difference and a twentieth more, in hundredths", () => {
  assert.equal(amountToMove(near(0.602), null), near(0.64), "an empty account and a 0.1 stake: the 0.64 the page shows");
  assert.equal(amountToMove(near(0.602), near(0.3)), near(0.32));
  assert.equal(amountToMove(near(0.602), near(0.602)), 0n);
  assert.equal(amountToMove(near(0.602), near(5)), 0n);
});

/** A chain where `POKER` holds `held`, and a wallet that sends when asked; what happened is kept in `did`. */
function world(held: bigint | null, arrives = true) {
  const did: string[] = [];
  let balance = held;
  const tools: FundWith = {
    balance: async () => balance,
    send: async (backer, to, amount) => {
      did.push(`send ${(backer as { accountId: string }).accountId} -> ${to.slice(0, 6)} ${amount}`);
      if (arrives) balance = (balance ?? 0n) + amount;
    },
    sleep: async () => void did.push("wait"),
  };
  return { did, tools, held: () => balance };
}

test("one approval fills the poker account, and the page waits until the chain shows it", async () => {
  const w = world(null);
  const steps: string[] = [];
  await fundPoker(WALLET, POKER, near(0.602), (step) => steps.push(step), w.tools);
  assert.deepEqual(w.did, [`send alice.near -> 20adb3 ${near(0.64)}`]);
  assert.deepEqual(steps, ["approve", "moving"]);
  assert.ok(w.held()! >= near(0.602));
});

test("an account that holds enough is asked nothing; a refusal sends nothing and is told as it is", async () => {
  const rich = world(near(1));
  const steps: string[] = [];
  await fundPoker(WALLET, POKER, near(0.602), (step) => steps.push(step), rich.tools);
  assert.deepEqual([rich.did, steps], [[], []]);

  const refused = world(null);
  refused.tools.send = async () => {
    throw new Error("User rejected the request");
  };
  await assert.rejects(
    fundPoker(WALLET, POKER, near(0.602), () => {}, refused.tools),
    /User rejected/,
  );
  assert.equal(refused.held(), null);
});

test("NEAR that does not show up in time is said so, and pressing again sends nothing twice", async () => {
  const slow = world(null, false);
  await assert.rejects(
    fundPoker(WALLET, POKER, near(0.602), () => {}, slow.tools),
    /has not seen it land yet/,
  );
  assert.equal(slow.did.filter((line) => line.startsWith("send")).length, 1);
  // It lands meanwhile: the second press finds the account full and asks for nothing.
  const landed = world(near(0.64));
  await fundPoker(WALLET, POKER, near(0.602), () => {}, landed.tools);
  assert.deepEqual(landed.did, []);
});

test("what is left goes back to the club account, less the transfer's own gas", async () => {
  const sent: unknown[] = [];
  const session = { sendTo: async (to: string, actions: unknown[]) => (sent.push([to, actions]), { hash: "h", value: null }) } as never;
  assert.equal(await sendBack(session, "alice.near", near(0.7)), near(0.7) - KEPT_BACK);
  assert.deepEqual(sent, [["alice.near", [{ transfer: near(0.7) - KEPT_BACK }]]]);
  await assert.rejects(sendBack(session, "alice.near", KEPT_BACK), /nothing to send back/);
});
