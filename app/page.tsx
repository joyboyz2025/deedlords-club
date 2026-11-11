import { redirect } from "next/navigation";

// Standalone Deedlords: the game lives in the NEAR contract, so the home page goes straight to its matches.
// The room-server version of the same table is still at /co-ty-phu.
export default function HomePage() {
  redirect("/play");
}
