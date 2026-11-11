import type { Metadata } from "next";
import { PokerScreen } from "@/games/poker/components/PokerScreen";

export const metadata: Metadata = {
  title: "Deedlords Poker",
  description: "Heads-up Texas Hold'em with no dealer: the deck is shuffled and dealt by the two players' own cryptography, checked by a NEAR contract.",
};

export default function PokerPage() {
  return <PokerScreen />;
}
