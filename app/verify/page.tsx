import { Suspense } from "react";
import { VerifyTurn } from "@/games/co-ty-phu/components/VerifyTurn";

export default function Page() {
  return (
    <Suspense>
      <VerifyTurn />
    </Suspense>
  );
}
