/** Slack client: reads channel messages, thread replies, and user/channel names. */

import ky from "ky";
import { env } from "./config.ts";

function makeClient(token: string) {
  return ky.extend({
    baseUrl: "https://slack.com/api/",
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30_000,
    // Slack rate limits are strict for new apps — ride out 429s (Retry-After is honored).
    retry: { limit: 5, backoffLimit: 60_000 },
  });
}

const slackBot = makeClient(env.SLACK_BOT_TOKEN);
const slackUser = env.SLACK_USER_TOKEN === "" ? undefined : makeClient(env.SLACK_USER_TOKEN);
type SlackClient = typeof slackBot;

/** Whether a user token (xoxp) is configured as a read fallback. */
export const hasUserToken = slackUser !== undefined;

/**
 * Channels read with the user token instead of the bot token — private
 * channels the bot can't be invited to but the token's user is a member of.
 * Recomputed by the Slack sync each poll.
 */
const userTokenChannels = new Set<string>();

export function routeChannelsThroughUserToken(ids: Iterable<string>): void {
  userTokenChannels.clear();
  for (const id of ids) userTokenChannels.add(id);
}

function clientFor(channel: string): SlackClient {
  return slackUser !== undefined && userTokenChannels.has(channel) ? slackUser : slackBot;
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
}

/** One message as returned by conversations.history / conversations.replies. */
export interface SlackMessage {
  ts: string;
  user?: string;
  username?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
}

/** Slack reports errors as { ok: false } with HTTP 200 — surface them as throws. */
async function slackGet<T>(
  client: SlackClient,
  method: string,
  searchParams: Record<string, string>,
): Promise<T & SlackResponse> {
  const res = await client.get(method, { searchParams }).json<T & SlackResponse>();
  if (!res.ok) throw new Error(`Slack ${method} failed: ${res.error ?? "unknown error"}`);
  return res;
}

async function fetchAllMessages(
  client: SlackClient,
  method: string,
  params: Record<string, string>,
): Promise<SlackMessage[]> {
  const all: SlackMessage[] = [];
  let cursor: string | undefined;
  do {
    const res = await slackGet<{ messages: SlackMessage[] }>(client, method, {
      ...params,
      limit: "200",
      ...(cursor === undefined ? {} : { cursor }),
    });
    all.push(...res.messages);
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor !== undefined);
  return all.sort((a, b) => Number(a.ts) - Number(b.ts));
}

/** All channel messages newer than `oldest` (unix seconds), oldest first. */
export async function fetchChannelMessages(channel: string, oldest: string): Promise<SlackMessage[]> {
  return fetchAllMessages(clientFor(channel), "conversations.history", { channel, oldest });
}

/** A thread's messages (parent included — callers filter it out), oldest first. */
export async function fetchThreadReplies(channel: string, threadTs: string): Promise<SlackMessage[]> {
  return fetchAllMessages(clientFor(channel), "conversations.replies", { channel, ts: threadTs });
}

/** Ids of all channels the given client's identity is a member of. */
async function fetchMemberChannelIds(client: SlackClient): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const res = await slackGet<{ channels: { id: string; name?: string }[] }>(client, "users.conversations", {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const c of res.channels) {
      ids.add(c.id);
      if (c.name !== undefined) channelNames.set(c.id, c.name);
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor !== undefined);
  return ids;
}

/** Ids of all channels the bot is a member of, via users.conversations. */
export async function fetchBotChannelIds(): Promise<Set<string>> {
  return fetchMemberChannelIds(slackBot);
}

/** Ids of all channels the user token's user is a member of (empty without a token). */
export async function fetchUserChannelIds(): Promise<Set<string>> {
  if (slackUser === undefined) return new Set();
  return fetchMemberChannelIds(slackUser);
}

/** A channel as seen by the discovery check (id, name, visibility). */
export interface SlackChannelInfo {
  id: string;
  name: string;
  isPrivate: boolean;
}

/**
 * Every non-archived channel visible to the bot (all public ones plus private
 * ones it's in), and — when a user token is configured — the private channels
 * that token's user is a member of. Used to spot channels missing from
 * config.json.
 */
export async function fetchAllVisibleChannels(): Promise<Map<string, SlackChannelInfo>> {
  const channels = new Map<string, SlackChannelInfo>();
  const collect = async (client: SlackClient, method: string): Promise<void> => {
    let cursor: string | undefined;
    do {
      const res = await slackGet<{ channels: { id: string; name?: string; is_private?: boolean }[] }>(client, method, {
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: "200",
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const c of res.channels) {
        channels.set(c.id, { id: c.id, name: c.name ?? c.id, isPrivate: c.is_private ?? false });
        if (c.name !== undefined) channelNames.set(c.id, c.name);
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor !== undefined);
  };
  await collect(slackBot, "conversations.list");
  if (slackUser !== undefined) await collect(slackUser, "users.conversations");
  return channels;
}

let allChannelNamesLoaded = false;

/** Loads every visible channel's name into the cache (a few list requests). */
export async function preloadChannelNames(): Promise<void> {
  if (allChannelNamesLoaded) return;
  let cursor: string | undefined;
  do {
    const res = await slackGet<{ channels: { id: string; name?: string }[] }>(slackBot, "conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const c of res.channels) if (c.name !== undefined) channelNames.set(c.id, c.name);
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor !== undefined);
  allChannelNamesLoaded = true;
}

/** "#name" when the channel's name is known, otherwise the bare id. */
export function channelLabel(id: string): string {
  const name = channelNames.get(id);
  return name === undefined ? id : `#${name}`;
}

/** Joins a public channel — bots can self-join with the channels:join scope. */
export async function joinChannel(channel: string): Promise<void> {
  const res = await slackBot.post("conversations.join", { searchParams: { channel } }).json<SlackResponse>();
  if (!res.ok) throw new Error(`Slack conversations.join failed: ${res.error ?? "unknown error"}`);
}

const userNames = new Map<string, string>();

async function resolveUserName(userId: string): Promise<string> {
  const cached = userNames.get(userId);
  if (cached !== undefined) return cached;
  try {
    const { user } = await slackGet<{
      user: { name: string; profile?: { display_name?: string; real_name?: string } };
    }>(slackBot, "users.info", { user: userId });
    const name = user.profile?.display_name || user.profile?.real_name || user.name;
    userNames.set(userId, name);
    return name;
  } catch {
    return userId; // deleted user, missing users:read scope, …
  }
}

/** The message author's display name, resolved via users.info and cached. */
export async function resolveAuthor(msg: SlackMessage): Promise<string> {
  if (msg.user === undefined) return msg.username ?? "bot";
  return resolveUserName(msg.user);
}

const channelNames = new Map<string, string>();

/** The channel's name (without "#"), resolved via conversations.info and cached. */
export async function resolveChannelName(channel: string): Promise<string> {
  const cached = channelNames.get(channel);
  if (cached !== undefined) return cached;
  const res = await slackGet<{ channel: { name?: string } }>(clientFor(channel), "conversations.info", { channel });
  const name = res.channel.name ?? channel;
  channelNames.set(channel, name);
  return name;
}

let workspaceUrl: string | undefined;

/** Workspace base URL (https://myteam.slack.com/) via auth.test, cached. */
async function getWorkspaceUrl(): Promise<string> {
  workspaceUrl ??= (await slackGet<{ url: string }>(slackBot, "auth.test", {})).url;
  return workspaceUrl;
}

/** Archives permalink to a message; thread replies deep-link into their thread. */
export async function messagePermalink(channel: string, msg: SlackMessage): Promise<string> {
  const base = (await getWorkspaceUrl()).replace(/\/+$/, "");
  const link = `${base}/archives/${channel}/p${msg.ts.replace(".", "")}`;
  const isReply = msg.thread_ts !== undefined && msg.thread_ts !== msg.ts;
  return isReply ? `${link}?thread_ts=${msg.thread_ts}&cid=${channel}` : link;
}

/**
 * Converts Slack mrkdwn markup to plain text: <@U…> mentions become @names,
 * <url|label> links become "label (url)", and HTML entities are unescaped.
 */
export async function humanizeText(text: string): Promise<string> {
  let out = text;
  const mentionIds = [...new Set([...out.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]))];
  for (const id of mentionIds) {
    if (id === undefined) continue;
    const name = await resolveUserName(id);
    out = out.replace(new RegExp(`<@${id}(\\|[^>]*)?>`, "g"), `@${name}`);
  }
  return out
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
