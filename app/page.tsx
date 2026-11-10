import { redirect } from "next/navigation";

// Standalone deedlords: the only game is the property game, so the home page goes straight to its lobby.
export default function HomePage() {
  redirect("/co-ty-phu");
}
