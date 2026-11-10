// Which chain the web app talks to. Testnet by default; `sandbox` is the local playground started by
// `npm run dev:chain` in contracts/sandbox (a near-sandbox node behind a loopback stub). Mainnet is not wired yet.
//
// Until wallet sign-in exists, a seat can only be played through a helper on this machine that signs for test accounts:
// the sandbox stub (always there on `sandbox`), or on testnet `npm run play:testnet` in contracts/sandbox, named by
// NEXT_PUBLIC_DEEDLORDS_DEV_URL. Without a helper the page only watches.

export type Network = "testnet" | "sandbox";

export type ChainConfig = {
  network: Network;
  rpcUrl: string;
  contractId: string;
  /** The local helper that seats test accounts and adds session keys. `null`: there is none, the page only watches. */
  devUrl: string | null;
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
        pollMs: 500,
        blockHashTtlMs: 4_000,
      }
    : {
        network,
        rpcUrl: process.env.NEXT_PUBLIC_NEAR_RPC ?? "https://test.rpc.fastnear.com",
        contractId: process.env.NEXT_PUBLIC_DEEDLORDS_CONTRACT ?? "game.deedlords.testnet",
        devUrl: helperUrl,
        pollMs: 1_300,
        blockHashTtlMs: 60_000,
      };

/** What a move may burn. The contract refuses a move sent with less (`min_move_gas`). */
export const MOVE_GAS = 100_000_000_000_000n;
