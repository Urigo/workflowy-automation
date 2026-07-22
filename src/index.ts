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
import { env, repos } from "./config.ts";
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
console.log(`  Repos:     ${repos.join(", ")}`);
console.log(`  Workflowy: new tasks → "${env.WORKFLOWY_PARENT_ID}" (${env.WORKFLOWY_LAYOUT_MODE})`);
console.log(`  Mode:      ${cli.flags.once ? "run once" : `poll every ${env.POLL_INTERVAL_MINUTES} min`}\n`);

await runOnce();
if (!cli.flags.once) {
  setInterval(
    () => runOnce().catch((err) => console.error(`Poll error: ${errorMessage(err)}`)),
    env.POLL_INTERVAL_MINUTES * 60 * 1000,
  );
}
