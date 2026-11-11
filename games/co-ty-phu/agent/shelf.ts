// What the agent's desk remembers, shared by every route that plans a turn: the advice given per turn (so a model is
// asked once however often a turn is asked about) and the questions still out. One of each for the process, kept
// across the reloads of a dev server.

import type { Advice } from "./advise.ts";
import { AdviceBook } from "./book.ts";

// The names carry the book's version: a dev server that reloads this file must not keep a book made by older code.
const shelf = globalThis as { deedlordsAdviceV2?: AdviceBook; deedlordsAskingV2?: Map<string, Promise<Advice | null>> };

export const book = (shelf.deedlordsAdviceV2 ??= new AdviceBook());
export const asking = (shelf.deedlordsAskingV2 ??= new Map());
