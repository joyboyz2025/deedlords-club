// fight.ts: writes the fight the trailer plays, as the engine fights it. Nothing is staged: two floors go in, the
// engine's own events come out. Run from the repo root:
//
//   node --experimental-strip-types --import ./server/register.mjs tools/arena/trailer/fight.ts <out.json>
import { writeFileSync } from "node:fs";
import { UNITS } from "../../../games/arena/data.ts";
import { COLS, fight, type Fielded, type FightEvent } from "../../../games/arena/engine.ts";

const at = (id: string, row: number, col: number, rank = 1): Fielded => ({ unit: UNITS.findIndex((unit) => unit.id === id), rank, cell: row * COLS + col });
// Row 0 is each side's front row. The four units with skeletons lead the near side.
const teams: Fielded[][] = [
  [at("hask", 0, 3), at("grigg", 0, 2), at("eel", 0, 4), at("ko", 2, 3), at("opal", 2, 1), at("ysolde", 2, 5)],
  [at("tamsin", 0, 3), at("brann", 0, 2), at("finch", 0, 4), at("jory", 0, 5), at("mirela", 2, 2), at("sena", 2, 4)],
];
const events: FightEvent[] = [];
const result = fight(teams, (event) => events.push(event));
writeFileSync(process.argv[2], JSON.stringify({ teams, events, result }));
const count = (kind: string) => events.filter((event) => event.kind === kind).length;
console.log(`${process.argv[2]}: side ${result.winner} wins in ${result.ticks} ticks with ${result.survivors.length} standing; ${count("attack")} attacks, ${count("cast")} casts, ${count("move")} steps`);
