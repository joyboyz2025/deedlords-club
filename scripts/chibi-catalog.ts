// Writes contracts/chibi/src/catalog.rs from the chibi catalogue (games/chibi/catalog.ts). Run after changing
// games/ma-soi/look.ts or games/chibi/names.ts, then rebuild and upgrade the contract.

import { writeFileSync } from "node:fs";
import { catalogRust } from "../games/chibi/catalog.ts";

const target = new URL("../contracts/chibi/src/catalog.rs", import.meta.url);
writeFileSync(target, catalogRust());
console.log(`wrote ${target.pathname}`);
