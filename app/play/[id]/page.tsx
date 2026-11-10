import { ChainScreen } from "@/games/co-ty-phu/components/ChainScreen";

export default async function PlayMatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChainScreen id={decodeURIComponent(id)} />;
}
