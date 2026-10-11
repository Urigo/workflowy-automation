/** Loads .env + config.json and validates all settings; exports the typed config. */

import { readFileSync, writeFileSync } from "node:fs";
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
  // Reads private channels the bot can't be invited to. Acts as the token's
  // user: any channel that user is a member of becomes readable by the sync.
  SLACK_USER_TOKEN: str({ default: "", desc: "Slack user token (xoxp-…) — fallback for channels the bot isn't in" }),
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
  /**
   * GitHub token for this repo, resolved from the env var named by the
   * config's tokenEnv. Fine-grained PATs are scoped to one org — repos of
   * another org need their own token. Absent: GITHUB_TOKEN is used.
   */
  token?: string;
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
  /** Whether bot-posted messages (feeds, integrations) become bullets. */
  syncBots: boolean;
}

const configFileSchema = z.object({
  defaults: z
    .object({
      parentId: z.string().min(1).optional(),
      searchRootId: z.string().min(1).optional(),
      pullRequests: z.boolean().optional(),
      tokenEnv: z.string().min(1).optional(),
    })
    .optional(),
  repos: z
    .array(
      z.object({
        repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/name"'),
        parentId: z.string().min(1).optional(),
        searchRootId: z.string().min(1).optional(),
        pullRequests: z.boolean().optional(),
        tokenEnv: z.string().min(1).optional(),
      }),
    )
    .min(1),
  // How newly discovered Slack channels (not listed below) are handled.
  discovery: z
    .object({
      parentId: z.string().min(1).optional(),
      autoTrack: z.array(z.string().min(1)).optional(),
    })
    .optional(),
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
        bots: z.boolean().optional(),
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
  /** Every channel id listed in config.json, track:false entries included. */
  knownSlackChannelIds: Set<string>;
  discovery: DiscoveryConfig;
  /** Absolute path of config.json (undefined in legacy .env mode). */
  configFile?: string;
  /** Workflowy parent for channels added at runtime (defaults.parentId). */
  slackParentId: string;
}

/** How channels found in the workspace but missing from config.json are handled. */
export interface DiscoveryConfig {
  /** Workflowy node the "🆕 New Slack channels" decision bullet is created under. */
  parentId: string;
  /** Channel-name prefixes that are tracked right away instead of asked about. */
  autoTrack: string[];
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
    const { defaults, repos, slackChannels, discovery } = parsed.data;
    const slackParentId = defaults?.parentId ?? env.WORKFLOWY_PARENT_ID;
    // All listed ids (tracked or not) — channel discovery treats these as known.
    const knownSlackChannelIds = new Set(
      (slackChannels ?? []).flatMap((c) => c.channel.split(",").map((id) => id.trim())),
    );
    // "channel" may hold several comma-separated ids — one config per id.
    // track:false keeps a channel listed in config.json without syncing it.
    const channels = (slackChannels ?? [])
      .filter((c) => c.track !== false)
      .flatMap((c) =>
        c.channel.split(",").map((id) => ({
          channel: id.trim(),
          parentId: c.parentId ?? defaults?.parentId ?? env.WORKFLOWY_PARENT_ID,
          lookbackDays: c.lookbackDays ?? 300,
          syncBots: c.bots ?? true,
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
        const tokenEnv = r.tokenEnv ?? defaults?.tokenEnv;
        let token: string | undefined;
        if (tokenEnv !== undefined) {
          token = process.env[tokenEnv];
          if (token === undefined || token === "") {
            fail(`config.json: repo "${r.repo}" uses tokenEnv "${tokenEnv}", but that variable is not set in .env`);
          }
        }
        return {
          repo: r.repo,
          parentId: r.parentId ?? defaults?.parentId ?? env.WORKFLOWY_PARENT_ID,
          trackPullRequests: r.pullRequests ?? defaults?.pullRequests ?? true,
          ...(searchRootId === undefined ? {} : { searchRootId }),
          ...(token === undefined ? {} : { token }),
        };
      }),
      slackChannels: channels,
      knownSlackChannelIds,
      discovery: {
        parentId: discovery?.parentId ?? slackParentId,
        autoTrack: discovery?.autoTrack ?? [],
      },
      configFile: file,
      slackParentId,
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
    knownSlackChannelIds: new Set(),
    discovery: { parentId: env.WORKFLOWY_PARENT_ID, autoTrack: [] },
    slackParentId: env.WORKFLOWY_PARENT_ID,
  };
}

const configs = loadConfigs();
export const repoConfigs = configs.repos;
export const slackChannelConfigs = configs.slackChannels;
export const knownSlackChannelIds = configs.knownSlackChannelIds;
export const discoveryConfig = configs.discovery;

/** A channel to append to config.json's slackChannels list. */
export interface NewSlackChannelEntry {
  id: string;
  name: string;
  isPrivate: boolean;
  /** false lists the channel as inventory (track: false) without syncing it. */
  track: boolean;
  /** Only for tracked channels: false writes bots: false (skip app posts). */
  syncBots?: boolean;
}

/** The config.json line for one entry, following the file's conventions. */
export function slackChannelEntryLine(e: NewSlackChannelEntry, trailingComma = true): string {
  const opts = [e.track ? "" : ', "track": false', e.track && e.syncBots === false ? ', "bots": false' : ""].join("");
  return `{ "channel": "${e.id}"${opts} }${trailingComma ? "," : ""} // #${e.name}${e.isPrivate ? " (private)" : ""}`;
}

/**
 * Where the slackChannels array ends in the config text: the index of its
 * closing "]", the index of the last significant character before it ("}" of
 * the last entry, or "[" when empty), and the indentation of the entries.
 * Walks the text like the comment stripper so strings and // comments
 * containing brackets don't confuse it.
 */
function locateSlackChannelsArray(text: string): { close: number; lastSig: number; indent: string } {
  const key = /"slackChannels"\s*:\s*\[/g;
  const m = key.exec(text);
  if (m === null) throw new Error('config.json has no "slackChannels" array');
  const open = m.index + m[0].length - 1;
  let depth = 0;
  let lastSig = open;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      lastSig = i;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === undefined || /\s/.test(ch)) continue;
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        const lineStart = text.lastIndexOf("\n", lastSig) + 1;
        const indent = /^\s*/.exec(text.slice(lineStart, lastSig))?.[0] ?? "    ";
        return { close: i, lastSig, indent: lastSig === open ? "    " : indent };
      }
    }
    lastSig = i;
  }
  throw new Error('config.json: unterminated "slackChannels" array');
}

/**
 * Appends channel entries to config.json (under a dated comment, comments and
 * formatting elsewhere untouched) and registers them in memory, so tracked
 * ones are synced from the next poll on without a restart. The new text is
 * validated against the schema before anything is written.
 */
export async function addSlackChannelEntries(entries: NewSlackChannelEntry[], reason: string): Promise<void> {
  if (entries.length === 0) return;
  const file = configs.configFile;
  if (file === undefined) throw new Error("no config.json to update (legacy .env configuration)");

  const text = readFileSync(file, "utf8");
  const { close, lastSig, indent } = locateSlackChannelsArray(text);
  const lineStart = text.lastIndexOf("\n", close - 1) + 1;
  const closeOnOwnLine = text.slice(lineStart, close).trim() === "";
  const insertAt = closeOnOwnLine ? lineStart : close;
  const block =
    `${indent}// Added by channel discovery ${new Date().toISOString().slice(0, 10)} (${reason})\n` +
    entries.map((e, i) => `${indent}${slackChannelEntryLine(e, i < entries.length - 1)}\n`).join("");
  const comma = text[lastSig] === "}" ? "," : "";
  const updated =
    text.slice(0, lastSig + 1) + comma + text.slice(lastSig + 1, insertAt) + (closeOnOwnLine ? "" : "\n") + block + text.slice(insertAt);

  const check = configFileSchema.safeParse(JSON.parse(stripJsonComments(updated)));
  if (!check.success) {
    throw new Error(`updated config.json would be invalid: ${check.error.issues.map((i) => i.message).join("; ")}`);
  }
  writeFileSync(file, updated);

  for (const e of entries) {
    knownSlackChannelIds.add(e.id);
    if (!e.track || slackChannelConfigs.some((c) => c.channel === e.id)) continue;
    slackChannelConfigs.push({
      channel: e.id,
      parentId: configs.slackParentId,
      lookbackDays: 300,
      syncBots: e.syncBots ?? true,
    });
  }
}
