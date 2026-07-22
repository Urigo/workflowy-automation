#!/usr/bin/env node
/**
 * workflowy-github-sync
 *
 * Polls one or more GitHub repositories for newly opened issues and creates a
 * matching task in Workflowy for each one, using the official Workflowy API.
 *
 * Zero runtime dependencies — needs only Node 24+ (built-in fetch, native
 * .env loading, and import.meta.dirname). TypeScript is used at build time only.
 *
 * Run continuously:   node dist/index.js
 * Run once (for cron): node dist/index.js --once
 */

import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";

// import.meta.dirname resolves to dist/ at runtime; the .env / state files live
// alongside the project root, one level up.
const STATE_FILE = path.join(import.meta.dirname, "..", "state.json");
const ENV_FILE = path.join(import.meta.dirname, "..", ".env");

/** How long to wait on any single API request before giving up. */
const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Config {
  githubToken: string;
  workflowyApiKey: string;
  repos: string[];
  parentId: string;
  layoutMode: string;
  pollIntervalMinutes: number;
  backfillExisting: boolean;
}

interface RepoState {
  initialized: boolean;
  seen: number[];
}

interface State {
  repos: Record<string, RepoState>;
}

/** The subset of the GitHub issue payload this app relies on. */
interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  user?: { login?: string } | null;
  /** Present when the "issue" is actually a pull request. */
  pull_request?: unknown;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function getConfig(): Config {
  const required = (name: string): string => {
    const v = process.env[name];
    if (!v) {
      console.error(`\n❌ Missing required setting "${name}". Add it to your .env file.\n`);
      process.exit(1);
    }
    return v;
  };

  const repos = (process.env.GITHUB_REPOS ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  if (repos.length === 0) {
    console.error(`\n❌ No repositories configured. Set GITHUB_REPOS in .env (e.g. "my-org/api, my-org/web").\n`);
    process.exit(1);
  }

  return {
    githubToken: required("GITHUB_TOKEN"),
    workflowyApiKey: required("WORKFLOWY_API_KEY"),
    repos,
    // Where new tasks land in Workflowy. "inbox" = your Workflowy Inbox.
    parentId: process.env.WORKFLOWY_PARENT_ID || "inbox",
    layoutMode: process.env.WORKFLOWY_LAYOUT_MODE || "todo",
    pollIntervalMinutes: Number(process.env.POLL_INTERVAL_MINUTES || 5),
    // On the very first run, don't create tasks for issues that already exist —
    // just record them as "seen". Set BACKFILL_EXISTING=true to import them.
    backfillExisting: /^true$/i.test(process.env.BACKFILL_EXISTING ?? ""),
  };
}

// ---------------------------------------------------------------------------
// State (which issues we've already turned into tasks)
// ---------------------------------------------------------------------------
async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as State;
  } catch {
    // Missing or malformed file — start from an empty baseline.
    return { repos: {} };
  }
}

async function saveState(state: State): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------
async function fetchOpenIssues(repo: string, token: string): Promise<GitHubIssue[]> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    console.error(`⚠️  Skipping malformed repo entry "${repo}" (expected "owner/name").`);
    return [];
  }

  const issues: GitHubIssue[] = [];
  let page = 1;
  // GitHub returns pull requests from the issues endpoint too, so we filter them.
  while (true) {
    const url =
      `https://api.github.com/repos/${owner}/${name}/issues` +
      `?state=open&sort=created&direction=desc&per_page=100&page=${page}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "workflowy-github-sync",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API ${res.status} for ${repo}: ${body.slice(0, 300)}`);
    }

    const batch = (await res.json()) as GitHubIssue[];
    for (const item of batch) {
      if (item.pull_request) continue; // it's a PR, not an issue
      issues.push(item);
    }
    if (batch.length < 100) break;
    page += 1;
    if (page > 10) break; // safety cap: 1000 issues per poll
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Workflowy
// ---------------------------------------------------------------------------
async function createWorkflowyTask(
  issue: GitHubIssue,
  repo: string,
  cfg: Config,
): Promise<unknown> {
  const name = `${issue.title}  ·  ${repo}#${issue.number}`;
  const noteLines = [
    `${repo}#${issue.number} opened by @${issue.user?.login ?? "unknown"}`,
    issue.html_url,
  ];
  const body = {
    parent_id: cfg.parentId,
    name,
    note: noteLines.join("\n"),
    layoutMode: cfg.layoutMode,
    position: "bottom",
  };

  const res = await fetch("https://workflowy.com/api/v1/nodes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.workflowyApiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Workflowy API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Core sync for a single repo
// ---------------------------------------------------------------------------
async function syncRepo(repo: string, cfg: Config, state: State): Promise<number> {
  const repoState: RepoState = state.repos[repo] ?? { initialized: false, seen: [] };
  const seen = new Set(repoState.seen);

  const issues = await fetchOpenIssues(repo, cfg.githubToken);
  // Process oldest first so tasks appear in chronological order.
  const fresh = issues.filter((i) => !seen.has(i.number)).reverse();

  if (!repoState.initialized && !cfg.backfillExisting) {
    // First time we see this repo: record existing issues as a baseline
    // instead of flooding Workflowy with every open issue.
    for (const i of issues) seen.add(i.number);
    repoState.initialized = true;
    repoState.seen = [...seen];
    state.repos[repo] = repoState;
    console.log(`📌 ${repo}: baseline set (${issues.length} existing open issue(s) marked as seen).`);
    return 0;
  }

  let created = 0;
  for (const issue of fresh) {
    try {
      await createWorkflowyTask(issue, repo, cfg);
      seen.add(issue.number);
      created += 1;
      console.log(`✅ ${repo}#${issue.number} → Workflowy task created: "${issue.title}"`);
      // Persist after each success so a crash never re-creates a task.
      repoState.initialized = true;
      repoState.seen = [...seen];
      state.repos[repo] = repoState;
      await saveState(state);
    } catch (err) {
      console.error(`❌ Failed to create task for ${repo}#${issue.number}: ${errorMessage(err)}`);
      // Leave it unseen so we retry on the next poll.
    }
  }

  repoState.initialized = true;
  repoState.seen = [...seen];
  state.repos[repo] = repoState;
  return created;
}

async function runOnce(cfg: Config): Promise<void> {
  const state = await loadState();
  let total = 0;
  for (const repo of cfg.repos) {
    try {
      total += await syncRepo(repo, cfg, state);
    } catch (err) {
      console.error(`❌ Error syncing ${repo}: ${errorMessage(err)}`);
    }
  }
  await saveState(state);
  const stamp = new Date().toISOString();
  if (total > 0) console.log(`[${stamp}] Done — ${total} new task(s) created.`);
  else console.log(`[${stamp}] Checked ${cfg.repos.length} repo(s) — no new issues.`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Load .env (if present) using Node's built-in parser; real env vars win. */
function loadEnv(): void {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // No .env file — rely on the real environment.
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  loadEnv();
  const cfg = getConfig();
  const { values } = parseArgs({ options: { once: { type: "boolean", default: false } } });
  const once = values.once;

  console.log(`workflowy-github-sync`);
  console.log(`  Repos:     ${cfg.repos.join(", ")}`);
  console.log(`  Workflowy: new tasks → "${cfg.parentId}" (${cfg.layoutMode})`);
  console.log(`  Mode:      ${once ? "run once" : `poll every ${cfg.pollIntervalMinutes} min`}\n`);

  if (once) {
    await runOnce(cfg);
    return;
  }

  // Continuous loop
  await runOnce(cfg);
  setInterval(() => {
    runOnce(cfg).catch((err) => console.error(`Poll error: ${errorMessage(err)}`));
  }, cfg.pollIntervalMinutes * 60 * 1000);
}

main().catch((err) => {
  console.error(`Fatal: ${errorMessage(err)}`);
  process.exit(1);
});
