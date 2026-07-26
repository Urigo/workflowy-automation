/** Slack sync: new channel messages become bullets, thread replies sub-bullets. */

import { env, slackChannelConfigs, type SlackChannelConfig } from "./config.ts";
import {
  channelLabel,
  fetchBotChannelIds,
  fetchChannelMessages,
  fetchThreadReplies,
  humanizeText,
  joinChannel,
  messagePermalink,
  preloadChannelNames,
  resolveAuthor,
  resolveChannelName,
  type SlackMessage,
} from "./slack.ts";
import { db, type ChannelState } from "./state.ts";
import { errorMessage } from "./util.ts";
import {
  createSlackMessageBullet,
  createSlackReplyBullet,
  type SlackBulletContent,
} from "./workflowy.ts";

export interface SlackSyncCounts {
  messages: number;
  replies: number;
}

const zeroCounts = (): SlackSyncCounts => ({ messages: 0, replies: 0 });

function addCounts(target: SlackSyncCounts, add: SlackSyncCounts): void {
  target.messages += add.messages;
  target.replies += add.replies;
}

/** "1721721600.123456" → "2024-07-23 08:00" (UTC, matching GitHub bullets). */
function tsToWhen(ts: string): string {
  return new Date(Number(ts.split(".")[0]) * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/** Channel messages that should become bullets: top-level human messages. */
function isTopLevelMessage(msg: SlackMessage): boolean {
  return (
    msg.subtype === undefined &&
    msg.bot_id === undefined &&
    (msg.thread_ts === undefined || msg.thread_ts === msg.ts) &&
    (msg.text?.trim() ?? "") !== ""
  );
}

async function bulletContent(channel: string, msg: SlackMessage): Promise<SlackBulletContent> {
  return {
    author: await resolveAuthor(msg),
    when: tsToWhen(msg.ts),
    text: await humanizeText(msg.text?.trim() ?? ""),
    permalink: await messagePermalink(channel, msg),
  };
}

/** Records a message as tracked (bullet node known, message seen) and persists. */
async function recordMessage(state: ChannelState, ts: string, nodeId: string): Promise<void> {
  (state.taskIds ??= {})[ts] = nodeId;
  if (!state.seen.includes(ts)) state.seen.push(ts);
  state.initialized = true;
  await db.write();
}

/** Adds one thread reply sub-bullet, marks the reply seen, and persists. */
async function addReply(
  cfg: SlackChannelConfig,
  state: ChannelState,
  nodeId: string,
  reply: SlackMessage,
): Promise<SlackBulletContent> {
  const content = await bulletContent(cfg.channel, reply);
  await createSlackReplyBullet(nodeId, content);
  (state.seenReplies ??= []).push(reply.ts);
  await db.write();
  return content;
}

/** True for thread messages that shouldn't become reply sub-bullets. */
function skipReply(state: ChannelState, parentTs: string, reply: SlackMessage): boolean {
  return (
    reply.ts === parentTs ||
    (state.seenReplies?.includes(reply.ts) ?? false) ||
    (reply.text?.trim() ?? "") === ""
  );
}

/**
 * Creates the Workflowy bullet for a channel message. Newly created bullets
 * import every thread reply the message already has. Returns the sync counts.
 */
async function trackMessage(
  cfg: SlackChannelConfig,
  state: ChannelState,
  channelName: string,
  msg: SlackMessage,
): Promise<SlackSyncCounts> {
  const counts = zeroCounts();
  const content = await bulletContent(cfg.channel, msg);
  const nodeId = await createSlackMessageBullet(content, channelName, cfg.parentId);
  await recordMessage(state, msg.ts, nodeId);
  counts.messages += 1;
  console.log(`✅ #${channelName}: message by @${content.author} → Workflowy bullet created.`);

  if ((msg.reply_count ?? 0) === 0) return counts;

  // Bring over all replies the thread already has.
  try {
    for (const reply of await fetchThreadReplies(cfg.channel, msg.ts)) {
      if (skipReply(state, msg.ts, reply)) continue;
      await addReply(cfg, state, nodeId, reply);
      counts.replies += 1;
    }
    if (msg.latest_reply !== undefined) {
      (state.lastReplyTs ??= {})[msg.ts] = msg.latest_reply;
      await db.write();
    }
    console.log(`💬 #${channelName}: imported ${counts.replies} existing thread repl(y/ies).`);
  } catch (err) {
    // The bullet exists; missing replies shouldn't fail (and later duplicate) it.
    console.warn(`⚠️  #${channelName}: importing thread replies failed: ${errorMessage(err)}`);
  }
  return counts;
}

/**
 * Syncs thread activity. New replies on tracked messages become sub-bullets;
 * a new reply on an untracked message (part of the initial baseline) creates
 * its bullet retroactively — with the whole thread, via trackMessage. Every
 * decision is made by reply ts — lastReplyTs only picks which threads to
 * re-fetch.
 */
async function syncThreads(
  cfg: SlackChannelConfig,
  state: ChannelState,
  channelName: string,
  parents: SlackMessage[],
): Promise<SlackSyncCounts> {
  const counts = zeroCounts();
  const lastReply = (state.lastReplyTs ??= {});

  for (const msg of parents) {
    if ((msg.reply_count ?? 0) === 0 || msg.latest_reply === undefined) continue;
    if (msg.latest_reply <= (lastReply[msg.ts] ?? "")) continue;
    // A message that failed to get its bullet this poll stays unseen —
    // it retries (with its thread) as a new message next poll.
    if (!state.seen.includes(msg.ts)) continue;

    try {
      const nodeId = state.taskIds?.[msg.ts];
      if (nodeId === undefined) {
        addCounts(counts, await trackMessage(cfg, state, channelName, msg));
        continue;
      }
      for (const reply of await fetchThreadReplies(cfg.channel, msg.ts)) {
        if (skipReply(state, msg.ts, reply)) continue;
        const content = await addReply(cfg, state, nodeId, reply);
        counts.replies += 1;
        console.log(`💬 #${channelName}: thread reply by @${content.author} added.`);
      }
      lastReply[msg.ts] = msg.latest_reply;
      await db.write();
    } catch (err) {
      // Leave lastReplyTs untouched so this thread is retried on the next poll.
      console.error(`❌ Failed to sync a thread in #${channelName}: ${errorMessage(err)}`);
    }
  }
  return counts;
}

async function syncChannel(cfg: SlackChannelConfig): Promise<SlackSyncCounts> {
  const channels = (db.data.slackChannels ??= {});
  const state = (channels[cfg.channel] ??= { initialized: false, seen: [] });

  const channelName = await resolveChannelName(cfg.channel);
  const oldest = String(Math.floor(Date.now() / 1000) - cfg.lookbackDays * 24 * 60 * 60);
  const parents = (await fetchChannelMessages(cfg.channel, oldest)).filter(isTopLevelMessage);

  if (!state.initialized && !env.BACKFILL_EXISTING) {
    // First time we see this channel: record existing messages as a baseline
    // instead of flooding Workflowy with the recent history.
    state.initialized = true;
    state.seen = parents.map((m) => m.ts);
    state.lastReplyTs = {};
    for (const m of parents) {
      if (m.latest_reply !== undefined) state.lastReplyTs[m.ts] = m.latest_reply;
    }
    await db.write();
    console.log(`📌 #${channelName}: baseline set (${parents.length} message(s) marked as seen).`);
    return zeroCounts();
  }

  const counts = zeroCounts();
  const seen = new Set(state.seen);
  // parents is oldest-first, so bullets appear in chronological order.
  for (const msg of parents.filter((m) => !seen.has(m.ts))) {
    try {
      addCounts(counts, await trackMessage(cfg, state, channelName, msg));
    } catch (err) {
      // Leave it unseen so we retry on the next poll.
      console.error(`❌ Failed to create bullet for a message in #${channelName}: ${errorMessage(err)}`);
    }
  }
  addCounts(counts, await syncThreads(cfg, state, channelName, parents));
  return counts;
}

/** Syncs every configured Slack channel; errors are contained per channel. */
export async function syncSlackChannels(): Promise<SlackSyncCounts> {
  const total = zeroCounts();
  if (slackChannelConfigs.length === 0) return total;

  // Only channels the bot was invited to are readable — skip the rest instead
  // of burning a doomed (rate-limited) history call on each.
  let memberOf: Set<string>;
  try {
    memberOf = await fetchBotChannelIds();
  } catch (err) {
    console.error(`❌ Slack: listing the bot's channels failed: ${errorMessage(err)}`);
    return total;
  }
  let skipped = slackChannelConfigs.filter((cfg) => !memberOf.has(cfg.channel));
  if (skipped.length > 0) {
    try {
      await preloadChannelNames(); // so join/skip logs show names, not ids
    } catch (err) {
      console.warn(`⚠️  Slack: loading channel names failed: ${errorMessage(err)}`);
    }
  }

  // Public channels can be joined without an invite (SLACK_AUTO_JOIN=true).
  if (skipped.length > 0 && env.SLACK_AUTO_JOIN) {
    for (const cfg of skipped) {
      try {
        await joinChannel(cfg.channel);
        memberOf.add(cfg.channel);
        console.log(`➕ Slack: joined ${channelLabel(cfg.channel)}.`);
      } catch (err) {
        // Private channels can't be self-joined — they still need an /invite.
        console.warn(`⚠️  Slack: couldn't join ${channelLabel(cfg.channel)}: ${errorMessage(err)}`);
      }
    }
    skipped = slackChannelConfigs.filter((cfg) => !memberOf.has(cfg.channel));
  }

  if (skipped.length > 0) {
    console.log(
      `⏭️  Slack: skipping ${skipped.length} tracked channel(s) the bot isn't in (invite it with /invite): ` +
        skipped.map((cfg) => channelLabel(cfg.channel)).join(", "),
    );
  }
  const configs = slackChannelConfigs.filter((cfg) => memberOf.has(cfg.channel));

  for (const cfg of configs) {
    try {
      addCounts(total, await syncChannel(cfg));
    } catch (err) {
      console.error(`❌ Error syncing Slack channel ${cfg.channel}: ${errorMessage(err)}`);
    }
  }
  return total;
}
