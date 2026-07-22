/** Persistent state: which issues have already been turned into tasks. */

import path from "node:path";
import { JSONFilePreset } from "lowdb/node";
import { ROOT } from "./config.ts";

export interface RepoState {
  initialized: boolean;
  seen: number[];
}

export const db = await JSONFilePreset<{ repos: Record<string, RepoState> }>(
  path.join(ROOT, "state.json"),
  { repos: {} },
);
