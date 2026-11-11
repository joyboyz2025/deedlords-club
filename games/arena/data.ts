// The Arena's units, guilds, roles and numbers. The data lives in `shared/arena.json`, shared with the Rust engine in
// `contracts/arena-engine`; this file re-exports it with types. Pure data, used by the browser, the agent and the tests.

import arena from "../../shared/arena.json" with { type: "json" };

/** What an ability does. Amounts of `dmg`, `heal` and `shield` grow with the unit's rank; the others do not. */
export type Op = "shield" | "dmg" | "stun" | "heal" | "haste" | "energize" | "weaken" | "drain" | "ramp";
/** Whom an ability reaches. `target` is the unit just attacked; `near` is that unit and every enemy next to it; `around` is every enemy within two hexes of the caster. */
export type Who = "self" | "target" | "allyNear" | "allies" | "allyWeakest" | "weakest" | "three" | "farthest" | "near" | "around";

export type UnitDef = {
  id: string;
  name: string;
  guild: number;
  role: number;
  cost: number;
  hp: number;
  atk: number;
  armor: number;
  /** Ticks between two attacks. */
  cd: number;
  /** Ranged units hit from `rangedRange` hexes away, melee units from the next hex. */
  ranged: boolean;
  /** Its first move is a leap to the side of the enemy furthest away. */
  dive: boolean;
  /** The ability fires on every `every`th attack. */
  every: number;
  ability: { name: string; op: Op; who: Who; amount: number; text: string };
};

export type Trait = { name: string; at: number[]; bonus: number[]; text: string; color?: string };

export const C = arena.constants;
export const GUILDS: Trait[] = arena.guilds;
export const ROLES: Trait[] = arena.roles;
export const UNITS = arena.units as UnitDef[];

/** Guild indices, in the order of `shared/arena.json`. */
export const CANAL = 0;
export const SKYPORT = 1;
export const CUSTOMS = 2;
export const GRID = 3;
/** Role indices. */
export const GUARD = 0;
export const RUNNER = 1;
export const SIGNALLER = 2;
export const BROKER = 3;

/** 0, 1 or 2: how far a trait is switched on with `count` units of it on the floor. */
export const traitLevel = (trait: Trait, count: number): number => (count >= trait.at[1] ? 2 : count >= trait.at[0] ? 1 : 0);
/** The trait's number at that count, 0 when it is off. */
export const traitBonus = (trait: Trait, count: number): number => {
  const level = traitLevel(trait, count);
  return level ? trait.bonus[level - 1] : 0;
};
