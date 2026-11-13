"use client";

// What a player sees when their game account holds too little for the stake they picked: the way to the missing NEAR,
// right under the stake, instead of a closed button.
//
// Signed in with an EVM wallet on mainnet: the page asks NEAR Intents' 1Click (lib/chain/oneclick.ts) what the missing
// NEAR costs in a token the wallet holds, and one button asks the wallet to send exactly that to 1Click's deposit
// address (lib/chain/evmPay.ts). The owner approves the transfer in the wallet; 1Click swaps it and delivers NEAR to
// the game account; the page follows the swap and the stake opens up when the NEAR is there. A guest, or anybody on
// another kind of chain, gets the account's address to send NEAR to and the full 1Click form (CrossChain.tsx).

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Arrow, Copy } from "@/components/landing/icons";
import { CHAIN } from "@/lib/chain/config";
import { EVM_CHAINS, evmProvider, evmToken, payFromWallet, type EvmToken } from "@/lib/chain/evmPay";
import { ONECLICK_ASSETS, ONECLICK_MIN, SETTLED, assetById, assetName, statusLine, type OneClickAsset, type Quote, type SwapStatus } from "@/lib/chain/oneclick";
import { formatNear } from "../chain/adapt";
import type { Player } from "../chain/usePlayer";
import { CrossChain } from "./CrossChain";

const problemText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const POLL_MS = 4_000;
const HUNDREDTH = 10n ** 22n;
const STORE = (accountId: string) => `deedlords:topup:${CHAIN.network}:${accountId}`;

/** A payment sent from the wallet and not yet delivered, kept so that a reload goes on following it. */
type Sent = { quote: Quote; hash: string; startedAt: number };

/**
 * How much NEAR to bring for an account that holds `balance` and needs `needed`: the difference and a twentieth more
 * (gas prices move), in whole hundredths, and never less than 1Click's smallest swap.
 */
export function topUpAmount(needed: bigint, balance: bigint | null | undefined): bigint {
  const missing = needed - (balance ?? 0n);
  if (missing <= 0n) return 0n;
  const padded = (missing * 105n) / 100n;
  const rounded = ((padded + HUNDREDTH - 1n) / HUNDREDTH) * HUNDREDTH;
  return rounded < ONECLICK_MIN ? ONECLICK_MIN : rounded;
}

/** The tokens an EVM wallet can pay with, in the order offered. */
const WALLET_ASSETS = ONECLICK_ASSETS.filter((asset) => evmToken(asset) !== null);

async function askQuote(body: unknown): Promise<Quote> {
  const response = await fetch("/api/oneclick", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const answer = (await response.json().catch(() => ({}))) as { quote?: Quote; error?: string };
  if (!response.ok || !answer.quote) throw new Error(answer.error ?? `1Click is not answering (${response.status})`);
  return answer.quote;
}

// A quote names a deposit address 1Click keeps open for an hour: the same question is not asked again for a while.
const quotes = new Map<string, { quote: Quote; at: number }>();
const QUOTE_FOR_MS = 10 * 60_000;

function readSent(accountId: string): Sent | null {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE(accountId)) ?? "null") as Sent | null;
    return stored && Date.now() - stored.startedAt < 6 * 3600_000 ? stored : null;
  } catch {
    return null;
  }
}

function writeSent(accountId: string, sent: Sent | null) {
  try {
    if (sent) localStorage.setItem(STORE(accountId), JSON.stringify(sent));
    else localStorage.removeItem(STORE(accountId));
  } catch {
    // A private window: the swap goes through all the same; a reload only forgets to follow it.
  }
}

export function TopUp({ player, balance, needed, onArrived }: { player: Player; balance: bigint | null | undefined; needed: bigint; onArrived: () => void }) {
  const want = topUpAmount(needed, balance);
  const holds = typeof balance === "bigint" ? `${formatNear(balance.toString(), 2)} NEAR` : "nothing yet";
  const evmAddress = player.via === "key" && player.source === "evm" ? player.evmAddress : null;
  // Read after mount: the wallet is the browser's, and the server renders none.
  const [hasWallet, setHasWallet] = useState(false);
  useEffect(() => setHasWallet(evmProvider() !== null), []);
  const byWallet = CHAIN.network === "mainnet" && Boolean(evmAddress) && hasWallet;

  return (
    <div className="fd-topup" role="group" aria-label="Add NEAR for this stake">
      <p className="fd-topup__lead">
        <b>Add {formatNear(want.toString(), 2)} NEAR to play this stake.</b> Your game account holds {holds}; this table needs {formatNear(needed.toString(), 2)}: the stake, a
        storage deposit and a hold for gas, of which the deposit and the hold come back.
      </p>
      {byWallet && evmAddress ? (
        <WalletPay player={player} evmAddress={evmAddress} want={want} onArrived={onArrived} />
      ) : (
        <ByHand player={player} balance={balance} onArrived={onArrived} />
      )}
    </div>
  );
}

/** One button: the wallet pays 1Click's quote, and the swap is followed until the NEAR is on the account. */
function WalletPay({ player, evmAddress, want, onArrived }: { player: Player; evmAddress: string; want: bigint; onArrived: () => void }) {
  const id = useId();
  const [asset, setAsset] = useState<string>(WALLET_ASSETS[0].id);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [asking, setAsking] = useState(false);
  const [paying, setPaying] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  useEffect(() => setSent(readSent(player.accountId)), [player.accountId]);
  const keep = useCallback(
    (next: Sent | null) => {
      writeSent(player.accountId, next);
      setSent(next);
    },
    [player.accountId],
  );
  const token = assetById(asset) as OneClickAsset;
  const evm = evmToken(token) as EvmToken;

  // The price of the missing NEAR in the token picked, asked a moment after the choice settles.
  useEffect(() => {
    if (sent || want <= 0n) return;
    const key = `${player.accountId}:${asset}:${want}`;
    const known = quotes.get(key);
    if (known && Date.now() - known.at < QUOTE_FOR_MS) {
      setQuote(known.quote);
      setFailed(null);
      return;
    }
    setQuote(null);
    let stopped = false;
    const timer = setTimeout(() => {
      setAsking(true);
      setFailed(null);
      askQuote({ kind: "in", asset, near: want.toString(), recipient: player.accountId, refundTo: evmAddress })
        .then((answer) => {
          quotes.set(key, { quote: answer, at: Date.now() });
          if (!stopped) setQuote(answer);
        })
        .catch((error) => !stopped && setFailed(problemText(error)))
        .finally(() => !stopped && setAsking(false));
    }, 700);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [asset, want, sent, player.accountId, evmAddress]);

  const pay = async () => {
    const provider = evmProvider();
    if (!quote?.depositAddress || !provider) return;
    setPaying(true);
    setFailed(null);
    try {
      const hash = await payFromWallet(provider, evm, quote.depositAddress, BigInt(quote.amountIn), evmAddress);
      // Told at once, so 1Click looks for the deposit sooner; it finds it by itself all the same.
      void fetch("/api/oneclick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ submit: { depositAddress: quote.depositAddress, txHash: hash } }),
      }).catch(() => undefined);
      quotes.clear();
      keep({ quote, hash, startedAt: Date.now() });
    } catch (error) {
      setFailed(problemText(error));
    }
    setPaying(false);
  };

  if (sent) return <Following sent={sent} onArrived={onArrived} onDone={() => keep(null)} />;

  return (
    <div className="fd-topup__pay">
      <label className="fd-field" htmlFor={id}>
        <span>Pay with</span>
        <select id={id} value={asset} onChange={(event) => setAsset(event.target.value)} disabled={paying}>
          {WALLET_ASSETS.map((option) => (
            <option key={option.id} value={option.id}>
              {assetName(option)}
            </option>
          ))}
        </select>
      </label>
      <p className="fd-topup__price" role="status" aria-live="polite">
        {quote ? (
          <>
            <b>
              {quote.amountInFormatted} {token.symbol}
            </b>{" "}
            on {token.chain} for <b>{quote.amountOutFormatted} NEAR</b>
            {quote.timeEstimate ? `, in about ${quote.timeEstimate < 90 ? `${quote.timeEstimate} seconds` : `${Math.round(quote.timeEstimate / 60)} minutes`}` : ""}
            {quote.amountInUsd ? ` (about $${Number(quote.amountInUsd).toFixed(2)})` : ""}.
          </>
        ) : asking ? (
          "Asking NEAR Intents for the price…"
        ) : failed ? null : (
          "…"
        )}
      </p>
      <button type="button" className="fd-go" disabled={!quote?.depositAddress || paying} onClick={pay}>
        {paying ? "Approve it in your wallet…" : quote ? `Pay ${quote.amountInFormatted} ${token.symbol} from your wallet` : "Pay from your wallet"}
        {!paying && quote && <Arrow size={20} />}
      </button>
      {failed && (
        <p className="fd-problem" role="alert">
          {failed}
        </p>
      )}
      <p className="fd-fine">
        Your wallet ({evmAddress.slice(0, 6)}…{evmAddress.slice(-4)}) shows the transfer on {EVM_CHAINS[evm.chain].name} and you approve it there; it also needs a little ETH on{" "}
        {EVM_CHAINS[evm.chain].name} for that transfer&rsquo;s gas. NEAR Intents swaps it and delivers the NEAR to your game account. If the swap cannot go through, the token comes
        back to the same wallet.
      </p>
    </div>
  );
}

/** A payment on its way: the wallet's transaction, 1Click's word on the swap, and the NEAR arriving. */
function Following({ sent, onArrived, onDone }: { sent: Sent; onArrived: () => void; onDone: () => void }) {
  const { quote, hash } = sent;
  const token = assetById(quote.asset);
  const evm = token ? evmToken(token) : null;
  const [status, setStatus] = useState<SwapStatus | string>("KNOWN_DEPOSIT_TX");
  const [refunded, setRefunded] = useState<string | null>(null);
  const settled = SETTLED.includes(status as SwapStatus);
  const arrived = useRef(false);

  useEffect(() => {
    if (!quote.depositAddress || settled) return;
    let stopped = false;
    const read = async () => {
      try {
        const response = await fetch(`/api/oneclick?status=${encodeURIComponent(quote.depositAddress!)}`, { signal: AbortSignal.timeout(20_000) });
        const answer = (await response.json()) as { status?: string; refunded?: string | null };
        if (stopped || !answer.status) return;
        // The wallet has sent it: "waiting for your deposit" only means 1Click has not seen the chain confirm it yet.
        setStatus(answer.status === "PENDING_DEPOSIT" ? "KNOWN_DEPOSIT_TX" : answer.status);
        if (answer.refunded) setRefunded(answer.refunded);
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
  }, [quote.depositAddress, settled]);

  // Delivered: the balance is read again, which opens the stake; this panel goes when the account holds enough.
  useEffect(() => {
    if (status !== "SUCCESS" || arrived.current) return;
    arrived.current = true;
    onArrived();
    const again = setTimeout(onArrived, 4_000);
    return () => clearTimeout(again);
  }, [status, onArrived]);

  const step = status === "SUCCESS" ? 3 : status === "PROCESSING" ? 2 : 1;
  return (
    <div className="fd-topup__follow">
      <ol className="fd-topup__steps">
        <li data-done>
          Sent from your wallet: {quote.amountInFormatted} {token?.symbol}
          {evm && (
            <>
              {" "}
              <a href={`${EVM_CHAINS[evm.chain].explorerUrl}/tx/${hash}`} target="_blank" rel="noreferrer noopener">
                see it on {EVM_CHAINS[evm.chain].name}
              </a>
            </>
          )}
        </li>
        <li data-done={step >= 2 || undefined} data-now={step === 1 || undefined}>
          {step === 1 ? `${statusLine(status)} This takes a minute or two.` : "Deposit confirmed."}
        </li>
        <li data-done={step >= 3 || undefined} data-now={step === 2 || undefined}>
          {step >= 3 ? `${quote.amountOutFormatted} NEAR is on your game account.` : step === 2 ? "Swapping to NEAR…" : `${quote.amountOutFormatted} NEAR to your game account`}
        </li>
      </ol>
      {status === "SUCCESS" && (
        <p className="fd-topup__price" role="status">
          <b>Done.</b> Reading your balance: the stake opens in a moment.
        </p>
      )}
      {settled && status !== "SUCCESS" && (
        <p className="fd-problem" role="alert">
          {statusLine(status)}
          {refunded ? ` Refunded: ${refunded} ${token?.symbol ?? ""}.` : ""}
        </p>
      )}
      {!settled && <p className="fd-fine">You can leave this page: the swap goes on, and this follows it again when you are back.</p>}
      <button type="button" className="fd-pill fd-pill--quiet" onClick={onDone}>
        {settled ? (status === "SUCCESS" ? "Done" : "Try again") : "Stop following"}
      </button>
    </div>
  );
}

/** No wallet to ask: the account's address to send NEAR to, and 1Click's form for any other chain. */
function ByHand({ player, balance, onArrived }: { player: Player; balance: bigint | null | undefined; onArrived: () => void }) {
  const [copied, setCopied] = useState(false);
  const live = CHAIN.network === "mainnet";
  const copy = () =>
    void navigator.clipboard?.writeText(player.accountId).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  return (
    <div className="fd-topup__pay">
      <p className="fd-small">Send {live ? "NEAR" : `test NEAR on ${CHAIN.network}`} to your game account, from a wallet or an exchange:</p>
      <code className="fd-funds__address">{player.accountId}</code>
      <div className="fd-acts">
        <button type="button" className="fd-pill" onClick={copy}>
          <Copy size={16} /> {copied ? "Address copied" : "Copy the address"}
        </button>
        {CHAIN.network === "testnet" && (
          <a className="fd-pill" href="https://docs.near.org/getting-started/faucet" target="_blank" rel="noreferrer noopener">
            Testnet faucet
          </a>
        )}
      </div>
      {live && player.via === "key" && (
        <details className="fd-topup__more">
          <summary>Or pay from another chain: USDC, ETH, SOL, BTC</summary>
          <CrossChain player={player} balance={balance} onArrived={onArrived} />
        </details>
      )}
      <p className="fd-fine">This page shows the balance a few seconds after it lands, and the stake opens.</p>
    </div>
  );
}
