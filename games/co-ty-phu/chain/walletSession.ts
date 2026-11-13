// Playing with a NEAR wallet, through NEAR Connect (@hot-labs/near-connect, the connector NEAR's docs point to since
// wallet-selector; MyNearWallet, which had its own redirect protocol, was shut down in October 2026).
//
// Sign in: the page makes a key pair and asks the wallet to add the public half to the owner's account as a
// FUNCTION-CALL key for the game contract's move methods. The private half never leaves this browser and signs every
// move without a prompt. What carries a deposit (opening a match, taking a seat) goes to the wallet for approval.
// The connector is loaded on demand: it needs a browser, and most visitors never open it.

import type { NearConnector } from "@hot-labs/near-connect";
import { ContractFailure, failureText, type Session } from "@/lib/chain/client";
import { CHAIN } from "@/lib/chain/config";
import { generateKeyPair, parseSecretKey, publicKeyText, secretKeyText } from "@/lib/chain/keys";
import { chainClient } from "@/lib/chain/shared";
import type { FunctionCall } from "@/lib/chain/transaction";
import { readStored, removeStored, writeStored } from "@/lib/storage";
import { SESSION_ALLOWANCE, SESSION_METHODS } from "./calls";

const SIGNED_IN = `deedlords:wallet:${CHAIN.network}:${CHAIN.contractId}`;

type Stored = { accountId: string; secretKey: string; walletId: string };

export type WalletAccount = { accountId: string; session: Session; walletName: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const utf8 = new TextDecoder();

let loading: Promise<NearConnector> | null = null;
function connector(): Promise<NearConnector> {
  if (!CHAIN.wallets || CHAIN.network === "sandbox") return Promise.reject(new Error(`no NEAR wallet works on ${CHAIN.network}`));
  const network = CHAIN.network;
  loading ??= import("@hot-labs/near-connect").then(({ NearConnector: Connector }) => new Connector({ network, features: { [network]: true } }));
  return loading;
}

/**
 * Opens the wallet list; the chosen wallet asks its owner to add this browser's session key to the account.
 * Resolves once the wallet has answered; `openWalletSession` then waits for the key to show on chain.
 */
export async function signInWithNearWallet(): Promise<void> {
  const pair = generateKeyPair();
  const wallet = await (await connector()).connect({
    addFunctionCallKey: {
      contractId: CHAIN.contractId,
      publicKey: publicKeyText(pair.publicKey),
      allowMethods: { anyMethod: false, methodNames: [...SESSION_METHODS] },
      gasAllowance: { kind: "limited", amount: SESSION_ALLOWANCE },
    },
  });
  const [account] = await wallet.getAccounts();
  if (!account) throw new Error("the wallet connected without an account");
  writeStored(SIGNED_IN, { accountId: account.accountId, secretKey: secretKeyText(pair), walletId: wallet.manifest.id } satisfies Stored);
}

export function hasWalletAccount(): boolean {
  return readStored<Stored>(SIGNED_IN) !== null;
}

/** The connected wallet account's id, read from what this browser keeps: nothing is opened or asked of the wallet. */
export function storedWalletAccount(): string | null {
  return readStored<Stored>(SIGNED_IN)?.accountId ?? null;
}

/** The session of the connected account, or `null` when nobody is connected or the key is not on the account. */
export async function openWalletSession(): Promise<WalletAccount | null> {
  const stored = readStored<Stored>(SIGNED_IN);
  if (!stored) return null;
  let session: Session;
  try {
    session = chainClient.session(stored.accountId, parseSecretKey(stored.secretKey));
  } catch {
    removeStored(SIGNED_IN);
    return null;
  }
  // Right after the wallet's approval the node asked may still be a block behind the one that added the key.
  for (let i = 0; i < 12; i++) {
    if (await session.ready()) return { accountId: stored.accountId, session, walletName: stored.walletId };
    await sleep(500);
  }
  // Not on the account: its owner removed it, or the wallet connected without adding it.
  removeStored(SIGNED_IN);
  return null;
}

/** Hands the wallet one transaction (to the game contract unless `receiverId` says), for its owner to approve; resolves when it has run. */
export async function sendWithWallet(accountId: string, calls: FunctionCall[], receiverId: string = CHAIN.contractId): Promise<void> {
  const { wallet } = await (await connector()).getConnectedWallet();
  const outcome = await wallet.signAndSendTransaction({
    signerId: accountId,
    receiverId,
    actions: calls.map((call) => ({
      type: "FunctionCall" as const,
      params: { methodName: call.method, args: JSON.parse(utf8.decode(call.args)) as object, gas: call.gas.toString(), deposit: call.deposit.toString() },
    })),
  });
  const status = (outcome as { status?: { Failure?: unknown } } | undefined)?.status;
  if (status?.Failure !== undefined) throw new ContractFailure(failureText(status.Failure), "");
}

/** Disconnects the wallet and forgets the session key here. The key stays on the account until its owner deletes it. */
export async function signOutOfWallet(): Promise<void> {
  removeStored(SIGNED_IN);
  await connector()
    .then((opened) => opened.disconnect())
    .catch(() => undefined);
}
