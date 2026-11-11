// Which chain the web app talks to. Testnet by default; `sandbox` is the local playground started by
// `npm run dev:chain` in contracts/sandbox (a near-sandbox node behind a loopback stub). Mainnet is not wired yet.
//
// Who can take a seat: anybody with a game account (a key made in the browser, or derived from an EVM wallet), and on a
// real network anybody who connects a NEAR wallet. A helper on this machine can also sign for test accounts and hand
// out test NEAR: the sandbox stub (always there on `sandbox`), or on testnet `npm run play:testnet` in
// contracts/sandbox, named by NEXT_PUBLIC_DEEDLORDS_DEV_URL.

export type Network = "testnet" | "sandbox";

export type ChainConfig = {
  network: Network;
  rpcUrl: string;
  contractId: string;
  /** The local helper that seats test accounts and adds session keys. `null`: there is none. */
  devUrl: string | null;
  /** Whether NEAR wallets can connect (through NEAR Connect): on testnet, not on the sandbox, which no wallet knows. */
  wallets: boolean;
  /** Where a transaction can be looked at (`<explorerUrl>/txns/<hash>`), and the API that lists the contract's. `null`: nowhere. */
  explorerUrl: string | null;
  indexerUrl: string | null;
  /** How often an open match is re-read. A block is about 0.6 s on testnet. */
  pollMs: number;
  /** A transaction names a recent block and expires with it, so the hash is re-read after this long. */
  blockHashTtlMs: number;
};

const network: Network = process.env.NEXT_PUBLIC_NEAR_NETWORK === "sandbox" ? "sandbox" : "testnet";
const helperUrl = process.env.NEXT_PUBLIC_DEEDLORDS_DEV_URL?.replace(/\/$/, "") || null;
const devUrl = helperUrl ?? "http://127.0.0.1:8791";

export const CHAIN: ChainConfig =
  network === "sandbox"
    ? {
        network,
        rpcUrl: process.env.NEXT_PUBLIC_NEAR_RPC ?? `${devUrl}/rpc`,
        contractId: process.env.NEXT_PUBLIC_DEEDLORDS_CONTRACT ?? "game.sandbox",
        devUrl,
        wallets: false,
        explorerUrl: null,
        indexerUrl: null,
        pollMs: 500,
        blockHashTtlMs: 4_000,
      }
    : {
        network,
        rpcUrl: process.env.NEXT_PUBLIC_NEAR_RPC ?? "https://test.rpc.fastnear.com",
        contractId: process.env.NEXT_PUBLIC_DEEDLORDS_CONTRACT ?? "game.deedlords.testnet",
        devUrl: helperUrl,
        wallets: true,
        explorerUrl: "https://testnet.nearblocks.io",
        indexerUrl: "https://api-testnet.nearblocks.io",
        pollMs: 1_300,
        blockHashTtlMs: 60_000,
      };

/** What a move may burn. The contract refuses a move sent with less (`min_move_gas`). */
export const MOVE_GAS = 100_000_000_000_000n;
