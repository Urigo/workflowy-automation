/** Persistent state: which issues/comments have already been synced. */

import path from "node:path";
import { JSONFilePreset } from "lowdb/node";
import { ROOT } from "./config.ts";

export interface RepoState {
  initialized: boolean;
  /** Issue numbers already handled (baselined or turned into tasks). */
  seen: number[];
  /** Issue number → Workflowy node id of that issue's task bullet. */
  taskIds?: Record<string, string>;
  /** GitHub comment ids already processed (synced or deliberately skipped). */
  seenComments?: number[];
  /** Issue numbers whose Workflowy task is currently marked complete. */
  completedIssues?: number[];
  /**
   * Fetch optimization only — comments updated after this are requested from
   * GitHub. Whether a comment is new is always decided by id via seenComments.
   */
  commentsSince?: string;
}

export const db = await JSONFilePreset<{ repos: Record<string, RepoState> }>(
  path.join(ROOT, "state.json"),
  { repos: {} },
);
