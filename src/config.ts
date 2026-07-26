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
  SLACK_BOT_TOKEN: str({ default: "", desc: "Slack bot token (xoxb-…) — required when config.json lists slackChannels" }),
  // Joining posts a "joined the channel" system message visible to everyone
  // in the channel — enable deliberately. Needs the channels:join bot scope.
  SLACK_AUTO_JOIN: bool({ default: false, desc: "Auto-join public tracked channels the bot isn't in yet" }),
  // Lets config.json live outside this repo (e.g. in a private sibling repo).
  CONFIG_PATH: str({ default: "", desc: "Path to config.json, absolute or relative to the project root (default: ./config.json)" }),
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

/**
 * Per-Slack-channel settings, resolved from config.json (with defaults
 * applied). A config.json entry listing several comma-separated channel ids
 * expands into one of these per channel.
 */
export interface SlackChannelConfig {
  /** A single Slack channel id (C…), shown in the channel's "About" tab. */
  channel: string;
  /** Workflowy node that new message bullets are created under. */
  parentId: string;
  /** How many days back channel threads are watched for new replies. */
  lookbackDays: number;
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
  slackChannels: z
    .array(
      z.object({
        channel: z
          .string()
          .regex(
            /^[CGD][A-Z0-9]{5,}(\s*,\s*[CGD][A-Z0-9]{5,})*$/,
            'expected Slack channel id(s) like "C0123ABCDE" or "C0123ABCDE, C0456FGHIJ"',
          ),
        parentId: z.string().min(1).optional(),
        lookbackDays: z.number().int().positive().optional(),
        track: z.boolean().optional(),
      }),
    )
    .optional(),
});

function fail(message: string): never {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

/** Strips `//` line comments (outside strings) so config.json can be annotated. */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[++i] ?? "";
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      i--; // let the loop handle the newline, keeping line numbers stable
      continue;
    }
    out += ch;
  }
  return out;
}

interface LoadedConfigs {
  repos: RepoConfig[];
  slackChannels: SlackChannelConfig[];
}

function loadConfigs(): LoadedConfigs {
  const file = env.CONFIG_PATH === "" ? path.join(ROOT, "config.json") : path.resolve(ROOT, env.CONFIG_PATH);
  let raw: string | undefined;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    // An explicit CONFIG_PATH that can't be read is a setup error — fail loudly
    // instead of silently falling back to the legacy .env configuration.
    if (env.CONFIG_PATH !== "") {
      fail(`CONFIG_PATH is set but the file can't be read (${file}): ${err instanceof Error ? err.message : String(err)}`);
    }
    raw = undefined; // no config.json — fall back to .env below
  }

  if (raw !== undefined) {
    let json: unknown;
    try {
      json = JSON.parse(stripJsonComments(raw));
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
    const { defaults, repos, slackChannels } = parsed.data;
    // "channel" may hold several comma-separated ids — one config per id.
    // track:false keeps a channel listed in config.json without syncing it.
    const channels = (slackChannels ?? [])
      .filter((c) => c.track !== false)
      .flatMap((c) =>
        c.channel.split(",").map((id) => ({
          channel: id.trim(),
          parentId: c.parentId ?? defaults?.parentId ?? env.WORKFLOWY_PARENT_ID,
          lookbackDays: c.lookbackDays ?? 300,
        })),
      );
    if (channels.length > 0 && env.SLACK_BOT_TOKEN === "") {
      // Don't kill the GitHub sync over a missing Slack token — just skip Slack.
      console.warn(
        `⚠️  config.json lists ${channels.length} Slack channel(s) but SLACK_BOT_TOKEN is not set in .env — Slack sync is disabled.`,
      );
      channels.length = 0;
    }
    return {
      repos: repos.map((r) => {
        const searchRootId = r.searchRootId ?? defaults?.searchRootId;
        return {
          repo: r.repo,
          parentId: r.parentId ?? defaults?.parentId ?? env.WORKFLOWY_PARENT_ID,
          trackPullRequests: r.pullRequests ?? defaults?.pullRequests ?? true,
          ...(searchRootId === undefined ? {} : { searchRootId }),
        };
      }),
      slackChannels: channels,
    };
  }

  // Legacy .env configuration: same parent for every repo, no search root.
  const repos = env.GITHUB_REPOS.split(",").map((s) => s.trim()).filter(Boolean);
  if (repos.length === 0) {
    fail("No repositories configured. Create a config.json (see config.example.json).");
  }
  return {
    repos: repos.map((repo) => ({ repo, parentId: env.WORKFLOWY_PARENT_ID, trackPullRequests: true })),
    slackChannels: [],
  };
}

const configs = loadConfigs();
export const repoConfigs = configs.repos;
export const slackChannelConfigs = configs.slackChannels;
