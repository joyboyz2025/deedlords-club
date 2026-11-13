// Paying a 1Click deposit from an EVM wallet (lib/chain/evmPay.ts): what the wallet is asked, and in what order. The
// wallet here is a fake; a real payment is made by its owner, on mainnet.

import assert from "node:assert/strict";
import { test } from "node:test";
import { EVM_CHAINS, evmToken, payFromWallet, paymentRequest, transferData, type EvmProvider } from "../lib/chain/evmPay.ts";
import { ONECLICK_ASSETS, assetById } from "../lib/chain/oneclick.ts";

const USDC_BASE = assetById("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near")!;
const ETH_ARB = assetById("nep141:arb.omft.near")!;
const ME = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";
const DEPOSIT = "0x1111111111111111111111111111111111111111";

test("the tokens an EVM wallet can pay with are the ones on Base, Arbitrum and Ethereum, each with its contract", () => {
  assert.deepEqual(evmToken(USDC_BASE), { chain: "Base", chainId: 8453, contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" });
  assert.deepEqual(evmToken(ETH_ARB), { chain: "Arbitrum", chainId: 42161, contract: null });
  const offered = ONECLICK_ASSETS.filter((asset) => evmToken(asset)).map((asset) => `${asset.symbol}/${asset.chain}`);
  assert.deepEqual(offered, ["USDC/Base", "USDC/Arbitrum", "USDC/Ethereum", "USDT/Ethereum", "ETH/Base", "ETH/Arbitrum"]);
  assert.equal(evmToken(assetById("nep141:sol.omft.near")!), null);
  assert.equal(evmToken(assetById("nep141:btc.omft.near")!), null);
});

test("an ERC-20 payment is a transfer on the token's contract; ETH goes to the address itself", () => {
  // transfer(address,uint256): the selector, the address and the amount, each in 32 bytes.
  assert.equal(transferData(DEPOSIT, 570_000n), `0xa9059cbb${"0".repeat(24)}${"1".repeat(40)}${"0".repeat(59)}8b290`);
  assert.deepEqual(paymentRequest(evmToken(USDC_BASE)!, ME, DEPOSIT, 570_000n), {
    from: ME,
    to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    data: transferData(DEPOSIT, 570_000n),
    value: "0x0",
  });
  assert.deepEqual(paymentRequest(evmToken(ETH_ARB)!, ME, DEPOSIT, 10n ** 15n), { from: ME, to: DEPOSIT, value: "0x38d7ea4c68000" });
  assert.throws(() => transferData("0x123", 1n), /not an EVM address/);
  assert.throws(() => paymentRequest(evmToken(USDC_BASE)!, ME, DEPOSIT, 0n), /nothing to send/);
});

/** A wallet that answers from a script and keeps what it was asked. */
function wallet(script: Record<string, (params: unknown[]) => unknown>): EvmProvider & { asked: { method: string; params?: unknown[] }[] } {
  const asked: { method: string; params?: unknown[] }[] = [];
  return {
    asked,
    async request(args) {
      asked.push(args);
      const answer = script[args.method];
      if (!answer) throw Object.assign(new Error(`unexpected ${args.method}`), { code: -32601 });
      return answer(args.params ?? []);
    },
  };
}
const refuse =
  (code: number, message = "no") =>
  () => {
    throw Object.assign(new Error(message), { code });
  };
const HASH = `0x${"ab".repeat(32)}`;

test("the wallet is switched to the token's chain, then shown the one transfer", async () => {
  let chain = "0x1";
  const w = wallet({
    eth_requestAccounts: () => [ME],
    eth_chainId: () => chain,
    wallet_switchEthereumChain: (params) => void (chain = (params[0] as { chainId: string }).chainId),
    eth_sendTransaction: () => HASH,
  });
  assert.equal(await payFromWallet(w, evmToken(USDC_BASE)!, DEPOSIT, 570_000n, ME.toLowerCase()), HASH);
  assert.deepEqual(
    w.asked.map((ask) => ask.method),
    ["eth_requestAccounts", "eth_chainId", "wallet_switchEthereumChain", "eth_sendTransaction"],
  );
  assert.deepEqual(w.asked[2].params, [{ chainId: "0x2105" }]);
  assert.deepEqual(w.asked[3].params, [paymentRequest(evmToken(USDC_BASE)!, ME, DEPOSIT, 570_000n)]);

  // Already on the chain: no switch. A chain the wallet does not know is added.
  const there = wallet({ eth_requestAccounts: () => [ME], eth_chainId: () => "0x2105", eth_sendTransaction: () => HASH });
  await payFromWallet(there, evmToken(USDC_BASE)!, DEPOSIT, 1n);
  assert.deepEqual(
    there.asked.map((ask) => ask.method),
    ["eth_requestAccounts", "eth_chainId", "eth_sendTransaction"],
  );
  const unknown = wallet({
    eth_requestAccounts: () => [ME],
    eth_chainId: () => "0x1",
    wallet_switchEthereumChain: refuse(4902),
    wallet_addEthereumChain: () => null,
    eth_sendTransaction: () => HASH,
  });
  await payFromWallet(unknown, evmToken(ETH_ARB)!, DEPOSIT, 1n);
  const added = unknown.asked.find((ask) => ask.method === "wallet_addEthereumChain")!.params![0] as { chainId: string; chainName: string };
  assert.deepEqual([added.chainId, added.chainName], ["0xa4b1", EVM_CHAINS.Arbitrum.name]);
});

test("nothing is sent when the owner declines, when the wallet is on another account, or when it stays on another network", async () => {
  const declined = wallet({ eth_requestAccounts: () => [ME], eth_chainId: () => "0x2105", eth_sendTransaction: refuse(4001) });
  await assert.rejects(payFromWallet(declined, evmToken(USDC_BASE)!, DEPOSIT, 1n), /declined the payment.*Nothing was sent/);

  const other = wallet({ eth_requestAccounts: () => ["0x2222222222222222222222222222222222222222"], eth_chainId: () => "0x2105", eth_sendTransaction: () => HASH });
  await assert.rejects(payFromWallet(other, evmToken(USDC_BASE)!, DEPOSIT, 1n, ME), /another account/);
  assert.equal(
    other.asked.some((ask) => ask.method === "eth_sendTransaction"),
    false,
  );

  const stays = wallet({ eth_requestAccounts: () => [ME], eth_chainId: () => "0x1", wallet_switchEthereumChain: refuse(4001), eth_sendTransaction: () => HASH });
  await assert.rejects(payFromWallet(stays, evmToken(USDC_BASE)!, DEPOSIT, 1n), /another network.*Base/);
  assert.equal(
    stays.asked.some((ask) => ask.method === "eth_sendTransaction"),
    false,
  );

  const poor = wallet({ eth_requestAccounts: () => [ME], eth_chainId: () => "0x2105", eth_sendTransaction: refuse(-32000, "insufficient funds for gas * price + value") });
  await assert.rejects(payFromWallet(poor, evmToken(USDC_BASE)!, DEPOSIT, 1n), /does not hold enough on Base/);
});

test("what is brought to an account short of a stake: the difference and a little more, in hundredths, never under 1Click's least", async () => {
  // TopUp.tsx is a client component; its sum is checked here as written there.
  const HUNDREDTH = 10n ** 22n;
  const MIN = 10n ** 23n;
  const topUpAmount = (needed: bigint, balance: bigint | null | undefined): bigint => {
    const missing = needed - (balance ?? 0n);
    if (missing <= 0n) return 0n;
    const rounded = (((missing * 105n) / 100n + HUNDREDTH - 1n) / HUNDREDTH) * HUNDREDTH;
    return rounded < MIN ? MIN : rounded;
  };
  const near = (n: number) => BigInt(Math.round(n * 1000)) * 10n ** 21n;
  assert.equal(topUpAmount(near(0.28), 0n), near(0.3), "0.28 missing: 0.294 with the margin, 0.30 in hundredths");
  assert.equal(topUpAmount(near(0.28), null), near(0.3), "an account not on chain yet holds nothing");
  assert.equal(topUpAmount(near(0.28), near(0.25)), near(0.1), "never less than the smallest swap");
  assert.equal(topUpAmount(near(1.18), near(0.2)), near(1.03));
  assert.equal(topUpAmount(near(0.28), near(0.28)), 0n);
});
