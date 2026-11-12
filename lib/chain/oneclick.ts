// NEAR Intents' 1Click Swap API (https://docs.near-intents.org), as the club uses it: NEAR comes into a game account
// from a token on another chain, and goes back out to one. The pot itself is plain NEAR; 1Click only sits at the
// edges. 1Click has no testnet: on any network but mainnet a quote is asked with `dry: true` (a price, no deposit
// address), so the page can show what a mainnet deposit would cost without anybody sending anything.
//
// The browser talks to /api/oneclick, which talks to 1Click: the server can hold a partner key (ONECLICK_JWT, which
// lowers 1Click's fee from 0.25% to 0.2%) and keeps the asset list short and checked.

/** The tokens offered, by 1Click asset id. Kept short on purpose: the stablecoins and gas tokens people hold. */
export const ONECLICK_ASSETS = [
  { id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", symbol: "USDC", chain: "Base", decimals: 6 },
  { id: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", symbol: "USDC", chain: "Arbitrum", decimals: 6 },
  { id: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", symbol: "USDC", chain: "Ethereum", decimals: 6 },
  { id: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", symbol: "USDC", chain: "Solana", decimals: 6 },
  { id: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near", symbol: "USDT", chain: "Ethereum", decimals: 6 },
  { id: "nep141:base.omft.near", symbol: "ETH", chain: "Base", decimals: 18 },
  { id: "nep141:arb.omft.near", symbol: "ETH", chain: "Arbitrum", decimals: 18 },
  { id: "nep141:sol.omft.near", symbol: "SOL", chain: "Solana", decimals: 9 },
  { id: "nep141:btc.omft.near", symbol: "BTC", chain: "Bitcoin", decimals: 8 },
] as const;

export type OneClickAsset = (typeof ONECLICK_ASSETS)[number];
export const assetById = (id: string): OneClickAsset | undefined => ONECLICK_ASSETS.find((asset) => asset.id === id);
export const assetName = (asset: OneClickAsset) => `${asset.symbol} on ${asset.chain}`;

/** NEAR as 1Click names it: wrapped NEAR. A recipient on NEAR is paid in NEAR, and NEAR sent to a deposit address is taken as wNEAR. */
export const NEAR_ASSET = "nep141:wrap.near";

/** The smallest and the largest amount of NEAR one swap here may move, in yoctoNEAR. */
export const ONECLICK_MIN = 10n ** 23n; // 0.1 NEAR
export const ONECLICK_MAX = 100n * 10n ** 24n; // 100 NEAR

/** `in`: a token on another chain becomes exactly `near` NEAR on `recipient`. `out`: `near` NEAR becomes a token at `recipient` on another chain. */
export type QuoteAsk = { kind: "in" | "out"; asset: string; near: string; recipient: string; refundTo: string };

export type Quote = {
  kind: "in" | "out";
  asset: string;
  /** False on testnet: only a price, no deposit address. */
  live: boolean;
  /** Where to send: on the token's chain for `in`, a NEAR account for `out`. `null` for a dry quote. */
  depositAddress: string | null;
  /** What to send there, in the smallest units of what is sent (the token for `in`, yoctoNEAR for `out`), and for people. */
  amountIn: string;
  amountInFormatted: string;
  /** What arrives, likewise. */
  amountOut: string;
  amountOutFormatted: string;
  amountInUsd: string | null;
  amountOutUsd: string | null;
  /** Seconds 1Click expects the swap to take. */
  timeEstimate: number | null;
  /** After this the deposit address no longer swaps (ISO time). */
  deadline: string | null;
};

/** 1Click's words for where a swap is, from `GET /v0/status`. */
export type SwapStatus = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "PROCESSING" | "SUCCESS" | "INCOMPLETE_DEPOSIT" | "REFUNDED" | "FAILED";
export const SETTLED: readonly SwapStatus[] = ["SUCCESS", "REFUNDED", "FAILED"];

/** What a status means to the person waiting, in one line. */
export function statusLine(status: SwapStatus | string): string {
  switch (status) {
    case "PENDING_DEPOSIT":
      return "Waiting for your deposit.";
    case "KNOWN_DEPOSIT_TX":
      return "Deposit seen, waiting for it to confirm.";
    case "PROCESSING":
      return "Swapping.";
    case "SUCCESS":
      return "Done: delivered.";
    case "INCOMPLETE_DEPOSIT":
      return "Less arrived than the quote asked for. Send the rest, or wait for the refund.";
    case "REFUNDED":
      return "Refunded to the address you gave.";
    case "FAILED":
      return "The swap failed. 1Click refunds what it received.";
    default:
      return status;
  }
}

/** A NEAR account id (named or implicit). */
export const NEAR_ACCOUNT = /^(?:[0-9a-f]{64}|(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*)$/;

/** An address on the token's chain, by the chain's own shape. Loose on purpose: 1Click checks it again. */
export function addressProblem(asset: OneClickAsset, address: string): string | null {
  const a = address.trim();
  if (!a) return "An address is needed.";
  if (/\s/.test(a) || a.length > 100) return "That is not an address.";
  if (["Base", "Arbitrum", "Ethereum"].includes(asset.chain) && !/^0x[0-9a-fA-F]{40}$/.test(a)) return `An address on ${asset.chain} is 0x and 40 hex digits.`;
  if (asset.chain === "Solana" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return "That is not a Solana address.";
  if (asset.chain === "Bitcoin" && !/^(bc1|[13])[0-9a-zA-HJ-NP-Z]{20,90}$/.test(a)) return "That is not a Bitcoin address.";
  return null;
}
