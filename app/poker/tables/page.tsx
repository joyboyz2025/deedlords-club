import type { Metadata } from "next";
import { TablesScreen } from "@/games/poker/table/components/TablesScreen";
import "./tables.css";

export const metadata: Metadata = {
  title: "Deedlords Poker: tables of two to nine",
  description: "Texas Hold'em at tables of two to nine seats with no dealer: every seat shuffles the deck with its own key, and a NEAR contract checks each shuffle's proof.",
};

export default function PokerTablesPage() {
  return <TablesScreen />;
}
