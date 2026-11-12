import Image from "next/image";
import Link from "next/link";
import goldFoil from "@/assets/plates/gold-foil.webp";
import paper from "@/assets/plates/strip-paper.png";
import { Arrow } from "@/components/landing/icons";
import { NET_NAME } from "@/components/landing/net";
import { TopBar } from "@/components/landing/TopBar";
import { Trailer } from "@/components/landing/Trailer";
import { GUILDS, ROLES, UNITS } from "@/games/arena/data";

// The Arena's gate is closed for now: this page shows its trailer and its crews, and leads nowhere into the game.
// The game itself (games/arena, contracts/arena) stays in the repository, unrouted.

export default function ArenaPage() {
  return (
    <div className="lp at" style={{ "--lp-paper": `url(${paper.src})`, "--lp-foil": `url(${goldFoil.src})` } as React.CSSProperties}>
      <TopBar current="arena" />

      <main>
        <header className="at-head">
          <p className="at-head__gate">
            <span className="lp-poster__gate">
              Gate <b>C</b>
            </span>
            <i className="lp-status" data-soon>
              Trailer · gate not open yet
            </i>
          </p>
          <h1>Deedlords Arena</h1>
          <p className="lp-lede">An auto-battler of sealed bids. Hire a crew from four guilds, place it on the hexes, and watch a fight that has no dice in it.</p>
        </header>

        <Trailer src="/arena/trailer.mp4" poster="/arena/trailer-poster.webp" label="Deedlords Arena, the trailer" length="34 seconds" />

        <section className="lp-sec at-rules" aria-labelledby="at-rules">
          <h2 id="at-rules">Bid in secret. Fight in the open.</h2>
          <dl className="lp-trust">
            <div>
              <dt>How is a crew hired?</dt>
              <dd>Both players bid for the same units at the same time, sealed. The bids are opened together, so nobody can answer a bid they have seen.</dd>
            </div>
            <div>
              <dt>Who decides the fight?</dt>
              <dd>Nobody. There are no dice in it: the same two crews on the same hexes always fight the same way, so anyone can replay a fight and check it.</dd>
            </div>
            <div>
              <dt>What is a crew made of?</dt>
              <dd>
                {UNITS.length} units from {GUILDS.length} guilds in {ROLES.length} roles. Units of one guild or one role on the floor together switch on a bonus for the whole crew.
              </dd>
            </div>
            <div>
              <dt>When does the gate open?</dt>
              <dd>Not yet. The Arena is on hold while Deedlords and poker are finished; until then this trailer is all of it you can see here.</dd>
            </div>
          </dl>
        </section>

        <section className="lp-sec at-crews" aria-labelledby="at-crews">
          <h2 id="at-crews">The four guilds</h2>
          <p className="lp-lede">Sixteen units, four to a guild. Each has one ability, which fires on a count of its own attacks.</p>
          <div className="at-guilds">
            {GUILDS.map((guild, index) => (
              <section key={guild.name} className="at-guild" aria-label={guild.name} style={{ "--guild": guild.color } as React.CSSProperties}>
                <h3>{guild.name}</h3>
                <p>{guild.text}</p>
                <ul>
                  {UNITS.filter((unit) => unit.guild === index).map((unit) => (
                    <li key={unit.id}>
                      <Image src={`/arena/portraits/${unit.id}.jpg`} alt="" width={256} height={256} sizes="(min-width: 1100px) 120px, 22vw" />
                      <b>{unit.name}</b>
                      <small>{ROLES[unit.role].name}</small>
                      <span>
                        {unit.ability.name}: {unit.ability.text}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </section>

        <section className="lp-close at-close" aria-labelledby="at-close">
          <div className="lp-close__stub">
            <h2 id="at-close">Two gates are open</h2>
            <p>While the Arena waits, Deedlords and the poker table are boarding on {NET_NAME}.</p>
          </div>
          <div className="lp-close__stub lp-close__stub--go">
            <Link className="lp-go" href="/play">
              Play Deedlords <Arrow size={22} />
            </Link>
            <Link className="lp-watch" href="/poker/tables">
              Sit at poker <Arrow size={18} />
            </Link>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <p>
          <span className="lp-wordmark">Deedlords Club</span> Original games refereed by NEAR contracts, built for NEAR HACKATHON 2026, games track.
        </p>
      </footer>
    </div>
  );
}
