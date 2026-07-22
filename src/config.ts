/** Loads .env and validates all settings; exports the typed config. */

import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { bool, cleanEnv, num, str } from "envalid";

/** Project root — .env and state.json live here, one level above src/. */
export const ROOT = path.join(import.meta.dirname, "..");

loadDotenv({ path: path.join(ROOT, ".env"), quiet: true });

export const env = cleanEnv(process.env, {
  GITHUB_TOKEN: str({ desc: "GitHub token with read access to the repos" }),
  WORKFLOWY_API_KEY: str({ desc: "API key from https://workflowy.com/api-key" }),
  GITHUB_REPOS: str({ desc: 'Comma-separated repos, e.g. "my-org/api, my-org/web"' }),
  // Where new tasks land in Workflowy. "inbox" = your Workflowy Inbox.
  WORKFLOWY_PARENT_ID: str({ default: "inbox" }),
  WORKFLOWY_LAYOUT_MODE: str({ default: "todo" }),
  POLL_INTERVAL_MINUTES: num({ default: 5 }),
  // On the very first run, don't create tasks for issues that already exist —
  // just record them as "seen". Set BACKFILL_EXISTING=true to import them.
  BACKFILL_EXISTING: bool({ default: false }),
});

export const repos = env.GITHUB_REPOS.split(",").map((r) => r.trim()).filter(Boolean);
