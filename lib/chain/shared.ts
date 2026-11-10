import { ChainClient } from "./client.ts";
import { CHAIN } from "./config.ts";

/** One client for the page: it caches the block hash that transactions name. */
export const chainClient = new ChainClient(CHAIN);
