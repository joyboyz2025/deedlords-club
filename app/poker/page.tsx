import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PokerScreen } from "@/games/poker/components/PokerScreen";
import { CHAIN } from "@/lib/chain/config";

export const metadata: Metadata = {
  title: "Deedlords Poker",
  description: "Heads-up Texas Hold'em with no dealer: the deck is shuffled and dealt by the two players' own cryptography, checked by a NEAR contract.",
};

export default function PokerPage() {
  // Mainnet has one poker contract, the one for tables of two to nine seats (poker.deedlords.near); the heads-up
  // table speaks another protocol and lives on testnet only.
  if (CHAIN.network === "mainnet") redirect("/poker/tables");
  return <PokerScreen />;
}
