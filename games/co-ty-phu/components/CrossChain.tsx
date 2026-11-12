"use client";

// Bringing NEAR in from another chain, and sending it back out, through NEAR Intents' 1Click (lib/chain/oneclick.ts,
// /api/oneclick). In: the player picks a token and how much NEAR they want; 1Click names a deposit address on the
// token's chain and the exact amount to send there from their own wallet; the NEAR lands on the game account. Out: the
// game account sends NEAR to the address 1Click names, and the token arrives at the address the player typed. On
// testnet 1Click only prices: the panel says so and offers nothing to send.

import { QRCodeSVG } from "qrcode.react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Copy } from "@/components/landing/icons";
import { CHAIN } from "@/lib/chain/config";
import { ONECLICK_ASSETS, ONECLICK_MIN, SETTLED, addressProblem, assetById, assetName, statusLine, type Quote, type SwapStatus } from "@/lib/chain/oneclick";
import { formatNear } from "../chain/adapt";
import { near } from "../chain/calls";
import { approvesInWindow, withdraw, type Player } from "../chain/usePlayer";

const problemText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const POLL_MS = 5_000;
/** What stays on the account when NEAR goes out: the transfer's gas, and a move after it. */
const OUT_KEEPS = near(0.01);
const PENDING = (accountId: string) => `deedlords:oneclick:${CHAIN.network}:${accountId}`;

type Pending = { quote: Quote; startedAt: number };

const toYocto = (text: string): bigint | null => (/^\d+(?:\.\d{1,5})?$/.test(text.trim()) ? BigInt(Math.round(Number(text) * 100_000)) * 10n ** 19n : null);

async function askQuote(body: unknown): Promise<Quote> {
  const response = await fetch("/api/oneclick", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const answer = (await response.json().catch(() => ({}))) as { quote?: Quote; error?: string };
  if (!response.ok || !answer.quote) throw new Error(answer.error ?? `1Click is not answering (${response.status})`);
  return answer.quote;
}

function readPending(accountId: string): Pending | null {
  try {
    const stored = JSON.parse(localStorage.getItem(PENDING(accountId)) ?? "null") as Pending | null;
    return stored && Date.now() - stored.startedAt < 24 * 3600_000 ? stored : null;
  } catch {
    return null;
  }
}

function writePending(accountId: string, pending: Pending | null) {
  try {
    if (pending) localStorage.setItem(PENDING(accountId), JSON.stringify(pending));
    else localStorage.removeItem(PENDING(accountId));
  } catch {
    // A private window: the swap still goes through; this page just forgets it on reload.
  }
}

/** The panel: in or out, a quote, then the swap followed to its end. */
export function CrossChain({ player, balance, onArrived }: { player: Player; balance: bigint | null | undefined; onArrived: () => void }) {
  const [way, setWay] = useState<"in" | "out">("in");
  const [pending, setPending] = useState<Pending | null>(null);
  useEffect(() => setPending(readPending(player.accountId)), [player.accountId]);
  const keep = (next: Pending | null) => {
    writePending(player.accountId, next);
    setPending(next);
  };
  const live = CHAIN.network === "mainnet";

  return (
    <div className="fd-funds fd-funds--form fd-xchain">
      {!live && (
        <p className="fd-fine">
          1Click runs on NEAR mainnet only (NEAR Intents has no testnet). Here it gives a real price and nothing to send: on the mainnet club the same form brings NEAR in, and
          takes it out.
        </p>
      )}
      {pending ? (
        <Tracking pending={pending} player={player} onDone={() => keep(null)} onArrived={onArrived} />
      ) : (
        <>
          <div className="fd-segments" role="group" aria-label="Which way">
            <button type="button" aria-pressed={way === "in"} onClick={() => setWay("in")}>
              Bring NEAR in
            </button>
            <button type="button" aria-pressed={way === "out"} onClick={() => setWay("out")}>
              Take NEAR out
            </button>
          </div>
          <QuoteForm key={way} way={way} player={player} balance={balance} onStarted={(quote) => keep({ quote, startedAt: Date.now() })} />
        </>
      )}
    </div>
  );
}

function QuoteForm({ way, player, balance, onStarted }: { way: "in" | "out"; player: Player; balance: bigint | null | undefined; onStarted: (quote: Quote) => void }) {
  const ids = { asset: useId(), amount: useId(), address: useId() };
  const [asset, setAsset] = useState<string>(ONECLICK_ASSETS[0].id);
  const [amount, setAmount] = useState(way === "in" ? "0.5" : "");
  const [address, setAddress] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const token = assetById(asset)!;
  const yocto = toYocto(amount);
  const most = typeof balance === "bigint" && balance > OUT_KEEPS ? balance - OUT_KEEPS : 0n;
  const problem =
    amount.trim() && (yocto === null || yocto < ONECLICK_MIN)
      ? "At least 0.1 NEAR, with up to five decimals."
      : way === "out" && yocto !== null && yocto > most
        ? `At most ${formatNear(most.toString(), 5)} NEAR: a little stays to pay for the transfer.`
        : address.trim()
          ? addressProblem(token, address)
          : null;
  const ready = yocto !== null && yocto >= ONECLICK_MIN && address.trim() !== "" && problem === null;
  useEffect(() => setQuote(null), [asset, amount, address]);

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || yocto === null) return;
    setBusy(true);
    setFailed(null);
    try {
      setQuote(
        await askQuote(
          way === "in"
            ? { kind: "in", asset, near: yocto.toString(), recipient: player.accountId, refundTo: address.trim() }
            : { kind: "out", asset, near: yocto.toString(), recipient: address.trim(), refundTo: player.accountId },
        ),
      );
    } catch (error) {
      setFailed(problemText(error));
    }
    setBusy(false);
  };

  // Out: the game account sends the NEAR itself, straight from the click (a Google account approves it in the window).
  const send = () => {
    if (!quote?.depositAddress) return;
    setBusy(true);
    setFailed(null);
    withdraw(player, quote.depositAddress, BigInt(quote.amountIn))
      .then((hash) => {
        void fetch("/api/oneclick", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ submit: { depositAddress: quote.depositAddress, txHash: hash } }) });
        onStarted(quote);
      })
      .catch((error) => setFailed(problemText(error)))
      .finally(() => setBusy(false));
  };

  return (
    <form onSubmit={ask} className="fd-xchain__form">
      <label className="fd-field" htmlFor={ids.asset}>
        <span>{way === "in" ? "Pay with" : "Receive"}</span>
        <select id={ids.asset} value={asset} onChange={(event) => setAsset(event.target.value)}>
          {ONECLICK_ASSETS.map((option) => (
            <option key={option.id} value={option.id}>
              {assetName(option)}
            </option>
          ))}
        </select>
      </label>
      <label className="fd-field" htmlFor={ids.amount}>
        <span>{way === "in" ? "NEAR to get" : "NEAR to send"}</span>
        <input id={ids.amount} value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.5" autoComplete="off" />
      </label>
      <label className="fd-field" htmlFor={ids.address}>
        <span>{way === "in" ? `Your ${token.chain} address` : `To, on ${token.chain}`}</span>
        <input id={ids.address} value={address} onChange={(event) => setAddress(event.target.value)} placeholder={token.chain === "Solana" ? "Solana address" : token.chain === "Bitcoin" ? "bc1…" : "0x…"} autoComplete="off" spellCheck={false} />
      </label>
      {way === "in" && <p className="fd-fine">If the swap cannot go through, 1Click refunds this address.</p>}
      {!quote && (
        <button type="submit" className="fd-pill fd-pill--ink" disabled={!ready || busy}>
          {busy ? "Asking 1Click…" : "Get a quote"}
        </button>
      )}
      {quote && (
        <div className="fd-xchain__quote" role="status">
          {way === "in" ? (
            <p>
              Send <b>{quote.amountInFormatted} {token.symbol}</b> on {token.chain}, get <b>{quote.amountOutFormatted} NEAR</b> on this account
              {quote.timeEstimate ? `, in about ${quote.timeEstimate} s` : ""}.
            </p>
          ) : (
            <p>
              Send <b>{quote.amountInFormatted} NEAR</b>, get about <b>{quote.amountOutFormatted} {token.symbol}</b> on {token.chain}
              {quote.timeEstimate ? `, in about ${quote.timeEstimate} s` : ""}.
            </p>
          )}
          {quote.amountInUsd && quote.amountOutUsd && (
            <p className="fd-fine">
              ${Number(quote.amountInUsd).toFixed(2)} in, ${Number(quote.amountOutUsd).toFixed(2)} out: the difference is the market makers&rsquo; spread and 1Click&rsquo;s fee.
            </p>
          )}
          {!quote.live && <p className="fd-fine">A price only: on testnet there is nothing to send.</p>}
          {quote.live && way === "in" && (
            <button type="button" className="fd-pill fd-pill--ink" onClick={() => onStarted(quote)}>
              Show me where to send it
            </button>
          )}
          {quote.live && way === "out" && (
            <button type="button" className="fd-pill fd-pill--ink" disabled={busy} onClick={send}>
              {busy ? (approvesInWindow(player) ? "Waiting for your approval…" : "Sending…") : `Send ${quote.amountInFormatted} NEAR`}
            </button>
          )}
        </div>
      )}
      {(problem ?? failed) && (
        <p className="fd-problem" role="alert">
          {problem ?? failed}
        </p>
      )}
    </form>
  );
}

/** A swap under way: for `in`, where to send and how much; then 1Click's status, read every few seconds, to its end. */
function Tracking({ pending, player, onDone, onArrived }: { pending: Pending; player: Player; onDone: () => void; onArrived: () => void }) {
  const { quote } = pending;
  const token = assetById(quote.asset);
  const [status, setStatus] = useState<SwapStatus | string>("PENDING_DEPOSIT");
  const [delivered, setDelivered] = useState<{ hash: string; explorerUrl?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const settled = SETTLED.includes(status as SwapStatus);

  useEffect(() => {
    if (!quote.depositAddress || settled) return;
    let stopped = false;
    const read = async () => {
      try {
        const response = await fetch(`/api/oneclick?status=${encodeURIComponent(quote.depositAddress!)}`);
        const answer = (await response.json()) as { status?: string; delivered?: { hash: string; explorerUrl?: string } | null };
        if (stopped || !answer.status) return;
        setStatus(answer.status);
        if (answer.delivered) setDelivered(answer.delivered);
        if (answer.status === "SUCCESS") onArrived();
      } catch {
        // The next read tries again.
      }
    };
    void read();
    const timer = setInterval(() => document.visibilityState !== "hidden" && void read(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [quote.depositAddress, settled, onArrived]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(quote.depositAddress ?? "");
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="fd-xchain__track">
      {quote.kind === "in" && quote.depositAddress && !settled && (
        <>
          <p>
            Send exactly <b>{quote.amountInFormatted} {token?.symbol}</b> on <b>{token?.chain}</b> to this address, from your own wallet, before{" "}
            {quote.deadline ? new Date(quote.deadline).toLocaleTimeString() : "the quote runs out"}:
          </p>
          <div className="fd-funds__qr">
            <QRCodeSVG value={quote.depositAddress} size={112} bgColor="transparent" fgColor="#2a1208" level="M" />
          </div>
          <code className="fd-funds__address">{quote.depositAddress}</code>
          <button type="button" className="fd-pill" onClick={copy}>
            <Copy /> {copied ? "Copied" : "Copy the address"}
          </button>
          <p className="fd-fine">
            {quote.amountOutFormatted} NEAR then lands on {player.accountId.length > 24 ? "this account" : player.accountId}. Send only {token?.symbol} on {token?.chain} to it: anything
            else is lost.
          </p>
        </>
      )}
      <p className="fd-xchain__status" data-settled={settled || undefined} role="status">
        <b>1Click:</b> {statusLine(status)}
      </p>
      {delivered?.explorerUrl && (
        <a className="fd-fine" href={delivered.explorerUrl} target="_blank" rel="noreferrer noopener">
          See the delivery
        </a>
      )}
      <button type="button" className="fd-pill fd-pill--quiet" onClick={onDone}>
        {settled ? "Done" : "Stop following this swap"}
      </button>
      {!settled && <p className="fd-fine">Leaving this page does not stop the swap; it follows it again when you come back.</p>}
    </div>
  );
}
