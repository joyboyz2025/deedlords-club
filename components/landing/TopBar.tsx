import Link from "next/link";
import { Chain } from "./icons";
import { NET_NAME, ON_MAINNET, OTHER_NET } from "./net";

export type HallGame = "board" | "poker" | "arena";

/**
 * The top row of the hall's own pages (the landing and the Arena's trailer): the wordmark, the three games, the
 * visitor's own pages, the network. The front desk and the poker room draw the same row with their own account chip.
 */
export function TopBar({ current }: { current?: HallGame }) {
  const here = (game: HallGame) => (current === game ? "page" : undefined);
  return (
    <header className="lp-nav">
      <Link className="lp-wordmark" href="/" aria-label="Deedlords Club, home">
        Deedlords <small>Club</small>
      </Link>
      <nav aria-label="Deedlords Club">
        <Link href="/play" aria-current={here("board")}>
          Deedlords
        </Link>
        <Link href="/poker/tables" aria-current={here("poker")}>
          Poker
        </Link>
        <Link href="/arena" aria-current={here("arena")}>
          Arena
        </Link>
        <i aria-hidden="true" />
        <Link href="/character">Character</Link>
        <Link href="/agents">Agents</Link>
      </nav>
      <p className="lp-chip">
        <Chain size={18} /> {NET_NAME}
        {OTHER_NET.url ? (
          <a href={OTHER_NET.url}>· {OTHER_NET.name}</a>
        ) : (
          !ON_MAINNET && <span>· mainnet soon</span>
        )}
      </p>
    </header>
  );
}
