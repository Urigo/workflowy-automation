/** Core sync logic: diff open issues against seen-state, create tasks, persist. */

import { env, repos } from "./config.ts";
import { fetchOpenIssues } from "./github.ts";
import { db } from "./state.ts";
import { errorMessage } from "./util.ts";
import { createWorkflowyTask } from "./workflowy.ts";

async function syncRepo(repo: string): Promise<number> {
  const repoState = (db.data.repos[repo] ??= { initialized: false, seen: [] });
  const seen = new Set(repoState.seen);

  const issues = await fetchOpenIssues(repo);

  if (!repoState.initialized && !env.BACKFILL_EXISTING) {
    // First time we see this repo: record existing issues as a baseline
    // instead of flooding Workflowy with every open issue.
    repoState.initialized = true;
    repoState.seen = issues.map((i) => i.number);
    await db.write();
    console.log(`📌 ${repo}: baseline set (${issues.length} existing open issue(s) marked as seen).`);
    return 0;
  }

  // Process oldest first so tasks appear in chronological order.
  const fresh = issues.filter((i) => !seen.has(i.number)).reverse();

  let created = 0;
  for (const issue of fresh) {
    try {
      await createWorkflowyTask(issue, repo);
      seen.add(issue.number);
      created += 1;
      // Persist after each success so a crash never re-creates a task.
      repoState.initialized = true;
      repoState.seen = [...seen];
      await db.write();
      console.log(`✅ ${repo}#${issue.number} → Workflowy task created: "${issue.title}"`);
    } catch (err) {
      // Leave it unseen so we retry on the next poll.
      console.error(`❌ Failed to create task for ${repo}#${issue.number}: ${errorMessage(err)}`);
    }
  }
  return created;
}

export async function runOnce(): Promise<void> {
  let total = 0;
  for (const repo of repos) {
    try {
      total += await syncRepo(repo);
    } catch (err) {
      console.error(`❌ Error syncing ${repo}: ${errorMessage(err)}`);
    }
  }
  const stamp = new Date().toISOString();
  if (total > 0) console.log(`[${stamp}] Done — ${total} new task(s) created.`);
  else console.log(`[${stamp}] Checked ${repos.length} repo(s) — no new issues.`);
}
