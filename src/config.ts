/** Loads .env + config.json and validates all settings; exports the typed config. */

import { readFileSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { bool, cleanEnv, num, str } from "envalid";
import { z } from "zod";

/** Project root — .env, config.json and state.json live here, above src/. */
export const ROOT = path.join(import.meta.dirname, "..");

loadDotenv({ path: path.join(ROOT, ".env"), quiet: true });

export const env = cleanEnv(process.env, {
  GITHUB_TOKEN: str({ desc: "GitHub token with read access to the repos" }),
  WORKFLOWY_API_KEY: str({ desc: "API key from https://workflowy.com/api-key" }),
  // Legacy fallbacks, used only when there is no config.json.
  GITHUB_REPOS: str({ default: "", desc: 'Comma-separated repos (fallback when config.json is absent)' }),
  WORKFLOWY_PARENT_ID: str({ default: "inbox" }),
  WORKFLOWY_LAYOUT_MODE: str({ default: "todo" }),
  POLL_INTERVAL_MINUTES: num({ default: 5 }),
  // On the very first run, don't create tasks for issues that already exist —
  // just record them as "seen". Set BACKFILL_EXISTING=true to import them.
  BACKFILL_EXISTING: bool({ default: false }),
});

/** Per-repo settings, resolved from config.json (with defaults applied). */
export interface RepoConfig {
  repo: string;
  /** Workflowy node that new issue tasks are created under. */
  parentId: string;
  /**
   * Optional bullet to check for already-existing issue bullets. Its whole
   * subtree is searched — a match links the task instead of creating one.
   */
  searchRootId?: string;
  /** Whether new pull requests also become tasks (bot PRs are always skipped). */
  trackPullRequests: boolean;
}

const configFileSchema = z.object({
  defaults: z
    .object({
      parentId: z.string().min(1).optional(),
      searchRootId: z.string().min(1).optional(),
      pullRequests: z.boolean().optional(),
    })
    .optional(),
  repos: z
    .array(
      z.object({
        repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/name"'),
        parentId: z.string().min(1).optional(),
        searchRootId: z.string().min(1).optional(),
        pullRequests: z.boolean().optional(),
      }),
    )
    .min(1),
});

function fail(message: string): never {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

function loadRepoConfigs(): RepoConfig[] {
  const file = path.join(ROOT, "config.json");
  let raw: string | undefined;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    raw = undefined; // no config.json — fall back to .env below
  }

  if (raw !== undefined) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      fail(`config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = configFileSchema.safeParse(json);
    if (!parsed.success) {
      fail(
        `Invalid config.json:\n` +
          parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
      );
    }
    const { defaults, repos } = parsed.data;
    return repos.map((r) => {
      const searchRootId = r.searchRootId ?? defaults?.searchRootId;
      return {
        repo: r.repo,
        parentId: r.parentId ?? defaults?.parentId ?? env.WORKFLOWY_PARENT_ID,
        trackPullRequests: r.pullRequests ?? defaults?.pullRequests ?? true,
        ...(searchRootId === undefined ? {} : { searchRootId }),
      };
    });
  }

  // Legacy .env configuration: same parent for every repo, no search root.
  const repos = env.GITHUB_REPOS.split(",").map((s) => s.trim()).filter(Boolean);
  if (repos.length === 0) {
    fail("No repositories configured. Create a config.json (see config.example.json).");
  }
  return repos.map((repo) => ({ repo, parentId: env.WORKFLOWY_PARENT_ID, trackPullRequests: true }));
}

export const repoConfigs = loadRepoConfigs();
