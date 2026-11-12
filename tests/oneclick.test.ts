// The checks the club makes before asking 1Click for a quote (lib/chain/oneclick.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { NEAR_ACCOUNT, ONECLICK_ASSETS, SETTLED, addressProblem, assetById, statusLine } from "../lib/chain/oneclick.ts";

const asset = (chain: string, symbol = "USDC") => ONECLICK_ASSETS.find((one) => one.chain === chain && one.symbol === symbol)!;

test("only the listed tokens are offered", () => {
  assert.equal(assetById("nep141:wrap.near"), undefined, "NEAR itself is not a token to swap from here");
  assert.equal(assetById(ONECLICK_ASSETS[0].id)?.symbol, "USDC");
  assert.equal(new Set(ONECLICK_ASSETS.map((one) => one.id)).size, ONECLICK_ASSETS.length, "no token twice");
});

test("an address is checked by the shape of its chain", () => {
  assert.equal(addressProblem(asset("Base"), "0x52908400098527886E0F7030069857D2E4169EE7"), null);
  assert.match(addressProblem(asset("Base"), "0x5290")!, /40 hex digits/);
  assert.match(addressProblem(asset("Arbitrum"), "alice.near")!, /0x and 40 hex/);
  assert.equal(addressProblem(asset("Solana"), "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV"), null);
  assert.match(addressProblem(asset("Solana"), "0x52908400098527886E0F7030069857D2E4169EE7")!, /Solana/);
  assert.equal(addressProblem(asset("Bitcoin", "BTC"), "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"), null);
  assert.match(addressProblem(asset("Bitcoin", "BTC"), "not an address")!, /not an address/);
  assert.match(addressProblem(asset("Base"), "  ")!, /needed/);
});

test("a NEAR account is a named account or an implicit one", () => {
  assert.ok(NEAR_ACCOUNT.test("alice.near"));
  assert.ok(NEAR_ACCOUNT.test("a".repeat(64)));
  assert.ok(!NEAR_ACCOUNT.test("Alice.near"));
  assert.ok(!NEAR_ACCOUNT.test("0x52908400098527886E0F7030069857D2E4169EE7"));
});

test("every status has words, and the end states are known", () => {
  for (const status of ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS", "INCOMPLETE_DEPOSIT", "REFUNDED", "FAILED"]) assert.notEqual(statusLine(status), status);
  assert.deepEqual([...SETTLED].sort(), ["FAILED", "REFUNDED", "SUCCESS"]);
});
