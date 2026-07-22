#!/usr/bin/env node
/**
 * workflowy-github-sync
 *
 * Polls one or more GitHub repositories for newly opened issues and creates a
 * matching task in Workflowy for each one, using the official Workflowy API.
 *
 * The heavy lifting is delegated to focused packages — octokit (GitHub),
 * ky (HTTP), envalid (config), lowdb (state), meow (CLI), dotenv (.env) —
 * so this file only contains the actual sync logic. Node 26+ runs it
 * directly via native type stripping; `npm run typecheck` type-checks.
 */

import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { bool, cleanEnv, num, str } from "envalid";
import ky from "ky";
import { JSONFilePreset } from "lowdb/node";
import meow from "meow";
import { Octokit } from "octokit";

const ROOT = path.join(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// CLI, config, state
// ---------------------------------------------------------------------------
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

loadDotenv({ path: path.join(ROOT, ".env"), quiet: true });

const env = cleanEnv(process.env, {
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

const repos = env.GITHUB_REPOS.split(",").map((r) => r.trim()).filter(Boolean);

interface RepoState {
  initialized: boolean;
  seen: number[];
}

const db = await JSONFilePreset<{ repos: Record<string, RepoState> }>(
  path.join(ROOT, "state.json"),
  { repos: {} },
);

// ---------------------------------------------------------------------------
// API clients
// ---------------------------------------------------------------------------
const octokit = new Octokit({ auth: env.GITHUB_TOKEN });

const workflowy = ky.extend({
  baseUrl: "https://workflowy.com/api/v1/",
  headers: { Authorization: `Bearer ${env.WORKFLOWY_API_KEY}` },
  timeout: 30_000,
  retry: 2,
});

/** The subset of the GitHub issue payload this app relies on. */
interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  user?: { login?: string } | null;
}

async function fetchOpenIssues(repo: string): Promise<GitHubIssue[]> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    console.error(`⚠️  Skipping malformed repo entry "${repo}" (expected "owner/name").`);
    return [];
  }
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo: name,
    state: "open",
    per_page: 100,
  });
  // The issues endpoint also returns pull requests; filter them out.
  return issues.filter((i) => !i.pull_request);
}

async function createWorkflowyTask(issue: GitHubIssue, repo: string): Promise<void> {
  await workflowy.post("nodes", {
    json: {
      parent_id: env.WORKFLOWY_PARENT_ID,
      name: `${issue.title}  ·  ${repo}#${issue.number}`,
      note: [
        `${repo}#${issue.number} opened by @${issue.user?.login ?? "unknown"}`,
        issue.html_url,
      ].join("\n"),
      layoutMode: env.WORKFLOWY_LAYOUT_MODE,
      position: "bottom",
    },
  });
}

// ---------------------------------------------------------------------------
// Core sync
// ---------------------------------------------------------------------------
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

async function runOnce(): Promise<void> {
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
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
