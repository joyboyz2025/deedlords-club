// Which network this deployment of the club plays on, in the words its pages use. One deployment talks to one network
// (NEXT_PUBLIC_NEAR_NETWORK); the other one, when it is live, is linked by NEXT_PUBLIC_DEEDLORDS_MAINNET_URL or
// NEXT_PUBLIC_DEEDLORDS_TESTNET_URL.

import { CHAIN } from "@/lib/chain/config";

export const ON_MAINNET = CHAIN.network === "mainnet";
export const NET_NAME = `NEAR ${CHAIN.network}`;
/** The same club on the other network, when it is live: `null` when nothing is configured. */
export const OTHER_NET = ON_MAINNET
  ? { name: "NEAR testnet", url: process.env.NEXT_PUBLIC_DEEDLORDS_TESTNET_URL?.trim() || null }
  : { name: "NEAR mainnet", url: process.env.NEXT_PUBLIC_DEEDLORDS_MAINNET_URL?.trim() || null };
/** "NEAR" or "test NEAR": what a stake here is paid in. */
export const COIN = ON_MAINNET ? "NEAR" : "test NEAR";
