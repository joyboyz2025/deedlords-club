// The club's door to NEAR Intents' 1Click Swap API (see lib/chain/oneclick.ts).
//   POST { kind, asset, near, recipient, refundTo }  a quote; on mainnet with a deposit address, elsewhere a dry price
//   POST { submit: { depositAddress, txHash } }       tells 1Click a deposit was sent, so it looks sooner
//   GET  ?status=<depositAddress>                     where that swap is
// ONECLICK_JWT (optional) is the partner key: 1Click then charges its smaller fee. It never leaves this server.

import { CHAIN } from "@/lib/chain/config";
import { ONECLICK_MAX, ONECLICK_MIN, NEAR_ACCOUNT, NEAR_ASSET, addressProblem, assetById, type Quote, type QuoteAsk } from "@/lib/chain/oneclick";
import { clientKey, intEnv, rateLimiter } from "@/games/co-ty-phu/agent/rateLimit";

export const dynamic = "force-dynamic";

const BASE = (process.env.ONECLICK_URL?.trim() || "https://1click.chaindefuser.com").replace(/\/$/, "");
const JWT = process.env.ONECLICK_JWT?.trim() || null;
const LIVE = CHAIN.network === "mainnet";
/** Slippage the quote allows, in basis points: 1%. */
const SLIPPAGE = 100;
/** A deposit address takes deposits for this long. */
const DEADLINE_MS = 60 * 60_000;

const quotesPerIp = rateLimiter(intEnv(process.env.ONECLICK_IP_LIMIT, 30), 10 * 60_000);
const statusPerIp = rateLimiter(intEnv(process.env.ONECLICK_STATUS_LIMIT, 600), 10 * 60_000);

const answer = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function oneClick<T>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: T & { message?: string } }> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(JWT ? { authorization: `Bearer ${JWT}` } : {}), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(25_000),
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as T & { message?: string };
  return { ok: response.ok, status: response.status, body };
}

/** The checks a quote request passes before 1Click hears of it. Returns what is wrong, or null. */
function problemWith(ask: QuoteAsk): string | null {
  const asset = assetById(ask.asset);
  if (ask.kind !== "in" && ask.kind !== "out") return "kind is in or out";
  if (!asset) return "that token is not offered here";
  if (!/^\d{1,40}$/.test(ask.near)) return "near is an amount in yoctoNEAR";
  const near = BigInt(ask.near);
  if (near < ONECLICK_MIN || near > ONECLICK_MAX) return "between 0.1 and 100 NEAR per swap";
  if (ask.kind === "in") {
    if (!NEAR_ACCOUNT.test(ask.recipient)) return "the recipient is a NEAR account";
    return addressProblem(asset, ask.refundTo) && `refund address: ${addressProblem(asset, ask.refundTo)}`;
  }
  if (!NEAR_ACCOUNT.test(ask.refundTo)) return "the refund goes to a NEAR account";
  const wrong = addressProblem(asset, ask.recipient);
  return wrong && `recipient: ${wrong}`;
}

type QuoteAnswer = {
  quote?: {
    depositAddress?: string;
    amountIn: string;
    amountInFormatted: string;
    amountInUsd?: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd?: string;
    deadline?: string;
    timeEstimate?: number;
  };
};

export async function POST(request: Request) {
  const ip = clientKey(request);
  if (!quotesPerIp.allow(ip)) return answer(429, { error: "too many quotes from here: try again in a few minutes" });
  const body = (await request.json().catch(() => null)) as (QuoteAsk & { submit?: { depositAddress?: string; txHash?: string } }) | null;
  if (!body) return answer(400, { error: "a JSON body" });

  if (body.submit) {
    const { depositAddress, txHash } = body.submit;
    if (!LIVE) return answer(400, { error: "1Click runs on mainnet only" });
    if (typeof depositAddress !== "string" || typeof txHash !== "string" || depositAddress.length > 100 || txHash.length > 120) return answer(400, { error: "depositAddress and txHash" });
    const sent = await oneClick("/v0/deposit/submit", { method: "POST", body: JSON.stringify({ depositAddress, txHash }) }).catch(() => null);
    return sent?.ok ? answer(200, { ok: true }) : answer(502, { error: sent?.body.message ?? "1Click did not take it" });
  }

  const ask: QuoteAsk = { kind: body.kind, asset: String(body.asset ?? ""), near: String(body.near ?? ""), recipient: String(body.recipient ?? "").trim(), refundTo: String(body.refundTo ?? "").trim() };
  const wrong = problemWith(ask);
  if (wrong) return answer(400, { error: wrong });
  const asset = assetById(ask.asset)!;
  const inbound = ask.kind === "in";
  const request1 = {
    dry: !LIVE,
    // In: the player gets exactly this much NEAR. Out: exactly this much NEAR leaves, the token amount follows.
    swapType: inbound ? "EXACT_OUTPUT" : "EXACT_INPUT",
    slippageTolerance: SLIPPAGE,
    originAsset: inbound ? asset.id : NEAR_ASSET,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: inbound ? NEAR_ASSET : asset.id,
    amount: ask.near,
    refundTo: ask.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: ask.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + DEADLINE_MS).toISOString(),
    referral: "deedlords-club",
  };
  let got;
  try {
    got = await oneClick<QuoteAnswer>("/v0/quote", { method: "POST", body: JSON.stringify(request1) });
  } catch {
    return answer(502, { error: "1Click did not answer" });
  }
  if (!got.ok || !got.body.quote) return answer(got.status >= 500 ? 502 : 400, { error: got.body.message ?? `1Click answered ${got.status}` });
  const q = got.body.quote;
  const quote: Quote = {
    kind: ask.kind,
    asset: asset.id,
    live: LIVE,
    depositAddress: LIVE ? (q.depositAddress ?? null) : null,
    amountIn: q.amountIn,
    amountInFormatted: q.amountInFormatted,
    amountOut: q.amountOut,
    amountOutFormatted: q.amountOutFormatted,
    amountInUsd: q.amountInUsd ?? null,
    amountOutUsd: q.amountOutUsd ?? null,
    timeEstimate: q.timeEstimate ?? null,
    deadline: q.deadline ?? request1.deadline,
  };
  if (LIVE && !quote.depositAddress) return answer(502, { error: "1Click gave no deposit address" });
  return answer(200, { quote });
}

export async function GET(request: Request) {
  const ip = clientKey(request);
  if (!statusPerIp.allow(ip)) return answer(429, { error: "too many status reads from here" });
  const depositAddress = new URL(request.url).searchParams.get("status");
  if (!depositAddress || depositAddress.length > 100) return answer(400, { error: "?status=<deposit address>" });
  if (!LIVE) return answer(400, { error: "1Click runs on mainnet only" });
  try {
    const got = await oneClick<{ status?: string; swapDetails?: { destinationChainTxHashes?: { hash: string; explorerUrl?: string }[]; refundedAmountFormatted?: string } }>(
      `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
    );
    if (!got.ok) return answer(got.status >= 500 ? 502 : 400, { error: got.body.message ?? `1Click answered ${got.status}` });
    const delivered = got.body.swapDetails?.destinationChainTxHashes?.[0] ?? null;
    return answer(200, { status: got.body.status ?? "PENDING_DEPOSIT", delivered, refunded: got.body.swapDetails?.refundedAmountFormatted ?? null });
  } catch {
    return answer(502, { error: "1Click did not answer" });
  }
}
