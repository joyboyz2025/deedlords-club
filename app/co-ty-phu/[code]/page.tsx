import { TycoonScreen } from "@/games/co-ty-phu/components/TycoonScreen";

export default async function CoTyPhuRoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <TycoonScreen code={code.toUpperCase()} />;
}
