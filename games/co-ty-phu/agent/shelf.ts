// What the agent's desk remembers, shared by every route that plans a turn: the advice given per turn (so a model is
// asked once however often a turn is asked about) and the questions still out. One of each for the process, kept
// across the reloads of a dev server.

import type { Advice } from "./advise.ts";
import { AdviceBook } from "./book.ts";

const shelf = globalThis as { deedlordsAdvice?: AdviceBook; deedlordsAsking?: Map<string, Promise<Advice | null>> };

export const book = (shelf.deedlordsAdvice ??= new AdviceBook());
export const asking = (shelf.deedlordsAsking ??= new Map());
