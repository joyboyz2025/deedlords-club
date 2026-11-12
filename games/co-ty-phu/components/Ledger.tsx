"use client";

import { useEffect, useState } from "react";
import { CHAIN } from "@/lib/chain/config";
import { shortAccount } from "../chain/adapt";
import { mergeMoves, type MoveTx } from "../chain/ledger";

const EVERY_MS = 4_000;

type Listing = { rows: MoveTx[]; explorer: string | null; indexed: boolean; error?: string };

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const shortHash = (hash: string) => `${hash.slice(0, 6)}…${hash.slice(-4)}`;

/**
 * Every transaction of the match, newest first, each a link to the explorer. `sent` are the viewer's own, known the
 * moment they are sent; the rest comes from the indexer a few seconds after it happened. `nameOf` says who an account is
 * at this table.
 */
export function Ledger({ id, sent, nameOf, onClose }: { id: string; sent: MoveTx[]; nameOf: (accountId: string) => string | null; onClose?: () => void }) {
  const [listing, setListing] = useState<Listing | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = () =>
      fetch(`/api/moves?id=${encodeURIComponent(id)}`)
        .then((response) => response.json() as Promise<Listing>)
        .then((answer) => !stopped && setListing((before) => (answer.error && before ? { ...before, error: answer.error } : answer)))
        .catch(() => !stopped && setListing((before) => before ?? { rows: [], explorer: CHAIN.explorerUrl, indexed: false, error: "The list of transactions cannot be reached." }));
    void load();
    const timer = setInterval(() => document.visibilityState !== "hidden" && void load(), EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [id]);

  const rows = mergeMoves(listing?.rows ?? [], sent);
  const explorer = listing?.explorer ?? CHAIN.explorerUrl;

  return (
    <div className="dl-ledger">
      <div className="dl-ledger__head">
        <strong>Transactions</strong>
        <span className="dl-ledger__who">
          {rows.length} on NEAR {CHAIN.network}
        </span>
      </div>
      <p className="dl-ledger__note">
        Every move of this match is a transaction signed by its player and run by {CHAIN.contractId}.{explorer ? " Tap one to open it in the explorer." : ""}
      </p>
      {listing === null && rows.length === 0 ? (
        <p className="dl-ledger__note" aria-live="polite">
          Reading the chain…
        </p>
      ) : rows.length === 0 ? (
        <p className="dl-ledger__note">{listing?.indexed === false ? "This network has no explorer: your own moves will be listed here as you make them." : "Nothing yet."}</p>
      ) : (
        <ol className="dl-ledger__list">
          {rows.map((row) => {
            const who = nameOf(row.signer) ?? shortAccount(row.signer);
            const inside = (
              <>
                <span className="dl-ledger__what">{row.what}</span>
                <span className="dl-ledger__hash">{shortHash(row.hash)}</span>
                <span className="dl-ledger__who">
                  {who}
                  {row.ok ? "" : " · refused"}
                </span>
                <span className="dl-ledger__when">{clock(row.atMs)}</span>
              </>
            );
            return (
              <li key={row.hash}>
                {row.signedBy && (
                  <a className="dl-ledger__tee" href={`/verify?tx=${encodeURIComponent(row.hash)}&from=${encodeURIComponent(row.signer)}`} title={`The plan of this turn was signed inside a TEE by ${row.signedBy}: check it`}>
                    TEE-signed · {row.signedBy.split("/").pop()} · verify
                  </a>
                )}
                {explorer ? (
                  <a className="dl-ledger__row" data-failed={!row.ok || undefined} href={`${explorer}/txns/${row.hash}`} target="_blank" rel="noreferrer" title={row.hash}>
                    {inside}
                  </a>
                ) : (
                  <span className="dl-ledger__row" data-failed={!row.ok || undefined} title={row.hash}>
                    {inside}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {listing?.error && <p className="dl-ledger__note">The explorer's list is behind ({listing.error}); your own moves are shown.</p>}
      {explorer && (
        <a className="dl-ledger__note" href={`${explorer}/address/${CHAIN.contractId}`} target="_blank" rel="noreferrer">
          All transactions of {CHAIN.contractId} ↗
        </a>
      )}
      {onClose && (
        <button type="button" className="tp-btn tp-btn--big" onClick={onClose}>
          Close
        </button>
      )}
    </div>
  );
}
