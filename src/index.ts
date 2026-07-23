#!/usr/bin/env node
/**
 * workflowy-github-sync
 *
 * Polls one or more GitHub repositories for newly opened issues and creates a
 * matching task in Workflowy for each one, using the official Workflowy API.
 *
 * Node 26+ runs this directly via native type stripping; `npm run typecheck`
 * type-checks. See src/sync.ts for the core logic.
 */

import meow from "meow";
import { env, repoConfigs } from "./config.ts";
import { runOnce } from "./sync.ts";
import { errorMessage } from "./util.ts";

const cli = meow(
  `
  Usage
    $ workflowy-github-sync            Poll continuously
    $ workflowy-github-sync --once     Check once and exit (for cron)
`,
  {
    importMeta: import.meta,
    flags: { once: { type: "boolean", default: false } },
  },
);

console.log(`workflowy-github-sync`);
for (const cfg of repoConfigs) {
  const search = cfg.searchRootId === undefined ? "" : `, search: "${cfg.searchRootId}"`;
  const prs = cfg.trackPullRequests ? "" : ", PRs: off";
  console.log(`  ${cfg.repo} → "${cfg.parentId}"${search}${prs}`);
}
console.log(`  Mode: ${cli.flags.once ? "run once" : `poll every ${env.POLL_INTERVAL_MINUTES} min`} (${env.WORKFLOWY_LAYOUT_MODE})\n`);

await runOnce();
if (!cli.flags.once) {
  // A slow poll (many repos, rate-limited) must never overlap the next tick —
  // overlapping runs would race on state.json.
  let polling = false;
  setInterval(() => {
    if (polling) {
      console.warn("⏭️  Previous poll still running — skipping this tick.");
      return;
    }
    polling = true;
    runOnce()
      .catch((err) => console.error(`Poll error: ${errorMessage(err)}`))
      .finally(() => {
        polling = false;
      });
  }, env.POLL_INTERVAL_MINUTES * 60 * 1000);
}
