// Paying a 1Click deposit straight from the player's own EVM wallet (EIP-1193): the page asks the wallet to send the
// quoted amount of the token to the quoted deposit address, and the wallet's owner approves it there. Nothing is ever
// signed here: the page only builds the request. See lib/chain/oneclick.ts for where the amount and the address come
// from, and games/co-ty-phu/components/TopUp.tsx for the panel.

import type { OneClickAsset } from "./oneclick.ts";

/** The EVM chains whose tokens the club takes, as wallets know them. */
export const EVM_CHAINS = {
  Base: { chainId: 8453, name: "Base", rpcUrl: "https://mainnet.base.org", explorerUrl: "https://basescan.org" },
  Arbitrum: { chainId: 42161, name: "Arbitrum One", rpcUrl: "https://arb1.arbitrum.io/rpc", explorerUrl: "https://arbiscan.io" },
  Ethereum: { chainId: 1, name: "Ethereum", rpcUrl: "https://eth.llamarpc.com", explorerUrl: "https://etherscan.io" },
} as const;
export type EvmChainName = keyof typeof EVM_CHAINS;

/** An asset an EVM wallet can pay with: its chain, and its token contract (`null`: the chain's own ETH). */
export type EvmToken = { chain: EvmChainName; chainId: number; contract: string | null };

/** What `asset` is to an EVM wallet, from its 1Click id (`nep141:base-0x….omft.near`, `nep141:base.omft.near`); `null` for a token of another kind of chain. */
export function evmToken(asset: Pick<OneClickAsset, "id" | "chain">): EvmToken | null {
  if (!(asset.chain in EVM_CHAINS)) return null;
  const chain = asset.chain as EvmChainName;
  const contract = /^nep141:[a-z]+-(0x[0-9a-f]{40})\.omft\.near$/.exec(asset.id)?.[1] ?? null;
  if (!contract && !/^nep141:[a-z]+\.omft\.near$/.test(asset.id)) return null;
  return { chain, chainId: EVM_CHAINS[chain].chainId, contract };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const word = (hex: string) => hex.padStart(64, "0");

/** The call data of ERC-20 `transfer(to, amount)`. */
export function transferData(to: string, amount: bigint): string {
  if (!ADDRESS.test(to)) throw new Error("not an EVM address");
  if (amount <= 0n) throw new Error("nothing to send");
  return `0xa9059cbb${word(to.slice(2).toLowerCase())}${word(amount.toString(16))}`;
}

/** The transaction that sends `amount` (smallest units) of the token to `to`, as `eth_sendTransaction` takes it. */
export function paymentRequest(token: EvmToken, from: string, to: string, amount: bigint): { from: string; to: string; data?: string; value: string } {
  if (!ADDRESS.test(from) || !ADDRESS.test(to)) throw new Error("not an EVM address");
  if (amount <= 0n) throw new Error("nothing to send");
  return token.contract ? { from, to: token.contract, data: transferData(to, amount), value: "0x0" } : { from, to, value: `0x${amount.toString(16)}` };
}

/** The provider an EVM wallet puts in the page (EIP-1193). */
export type EvmProvider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
export const evmProvider = (): EvmProvider | null => (typeof window === "undefined" ? null : ((window as { ethereum?: EvmProvider }).ethereum ?? null));

const code = (error: unknown): number | undefined => (error as { code?: number } | null)?.code;
const said = (error: unknown): string =>
  error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === "string" ? (error as { message: string }).message : String(error);

/**
 * Asks the wallet to send `amount` of `token` to `to`: it is switched to the token's chain first (added, when it does
 * not know it), then shown the transfer, which its owner approves or declines. Resolves to the transaction hash.
 * `expected`: the address the game account was made from; another account in the wallet is refused, so that a refund
 * goes where the quote said.
 */
export async function payFromWallet(provider: EvmProvider, token: EvmToken, to: string, amount: bigint, expected: string | null = null): Promise<string> {
  let from: string;
  try {
    from = ((await provider.request({ method: "eth_requestAccounts" })) as string[])[0];
  } catch (error) {
    throw new Error(code(error) === 4001 ? "The wallet was not connected." : `The wallet answered: ${said(error)}`);
  }
  if (!from) throw new Error("The wallet shared no account.");
  if (expected && from.toLowerCase() !== expected.toLowerCase())
    throw new Error(
      `The wallet is on another account (${from.slice(0, 6)}…${from.slice(-4)}). Switch it to ${expected.slice(0, 6)}…${expected.slice(-4)}, the one you signed in with.`,
    );
  const chain = EVM_CHAINS[token.chain];
  const wanted = `0x${chain.chainId.toString(16)}`;
  try {
    if (String(await provider.request({ method: "eth_chainId" })).toLowerCase() !== wanted) {
      try {
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: wanted }] });
      } catch (error) {
        // 4902: the wallet does not know this chain yet.
        if (code(error) !== 4902) throw error;
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: wanted,
              chainName: chain.name,
              rpcUrls: [chain.rpcUrl],
              blockExplorerUrls: [chain.explorerUrl],
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            },
          ],
        });
      }
    }
  } catch (error) {
    throw new Error(
      code(error) === 4001 ? `The wallet stayed on another network: this payment is on ${chain.name}.` : `The wallet could not switch to ${chain.name}: ${said(error)}`,
    );
  }
  try {
    const hash = await provider.request({ method: "eth_sendTransaction", params: [paymentRequest(token, from, to, amount)] });
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("the wallet gave no transaction hash");
    return hash;
  } catch (error) {
    if (code(error) === 4001) throw new Error("You declined the payment in the wallet. Nothing was sent.");
    throw new Error(
      /insufficient|exceeds balance/i.test(said(error))
        ? `The wallet does not hold enough on ${chain.name} for this payment and its gas.`
        : `The wallet did not send it: ${said(error)}`,
    );
  }
}

/** What the wallet's account holds of `token`, in its smallest units, read through the wallet itself; `null` when it cannot say (another network, no answer). */
export async function walletBalance(provider: EvmProvider, token: EvmToken, owner: string): Promise<bigint | null> {
  try {
    if (Number(await provider.request({ method: "eth_chainId" })) !== token.chainId) return null;
    const answer = token.contract
      ? await provider.request({ method: "eth_call", params: [{ to: token.contract, data: `0x70a08231${word(owner.slice(2).toLowerCase())}` }, "latest"] })
      : await provider.request({ method: "eth_getBalance", params: [owner, "latest"] });
    return typeof answer === "string" && /^0x[0-9a-fA-F]*$/.test(answer) ? BigInt(answer === "0x" ? "0x0" : answer) : null;
  } catch {
    return null;
  }
}
