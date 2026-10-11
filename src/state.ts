/** Persistent state: which issues/comments have already been synced. */

import path from "node:path";
import { JSONFilePreset } from "lowdb/node";
import { ROOT } from "./config.ts";

export interface RepoState {
  initialized: boolean;
  /** Set once existing open PRs have been baselined for this repo. */
  prInitialized?: boolean;
  /** Issue/PR numbers already handled (baselined or turned into tasks). */
  seen: number[];
  /** Issue number → Workflowy node id of that issue's task bullet. */
  taskIds?: Record<string, string>;
  /** GitHub comment ids already processed (synced or deliberately skipped). */
  seenComments?: number[];
  /** Issue numbers whose Workflowy task is currently marked complete. */
  completedIssues?: number[];
  /**
   * Fetch optimization only — comments updated after this are requested from
   * GitHub. Whether a comment is new is always decided by id via seenComments.
   */
  commentsSince?: string;
}

export interface ChannelState {
  initialized: boolean;
  /** Set once existing bot messages have been baselined for this channel. */
  botMessagesInitialized?: boolean;
  /** Message ts values already handled (baselined or turned into bullets). */
  seen: string[];
  /** Message ts → Workflowy node id of that message's bullet. */
  taskIds?: Record<string, string>;
  /** Thread reply ts values already processed. */
  seenReplies?: string[];
  /**
   * Fetch optimization only — a thread is re-fetched when the channel history
   * shows a latest_reply newer than this. Whether a reply is new is always
   * decided by ts via seenReplies.
   */
  lastReplyTs?: Record<string, string>;
  /**
   * When (epoch ms) the channel's full lookbackDays history was last fetched.
   * Polls in between use a short window; see syncChannel.
   */
  lastFullSweepAt?: number;
  /** When (epoch ms) this channel was last polled — paces quiet channels. */
  lastPolledAt?: number;
  /** ts of the newest message/reply seen — decides the active-vs-quiet cadence. */
  lastActivityTs?: string;
}

/** A discovered channel waiting for a track/ignore decision in Workflowy. */
export interface PendingChannel {
  name: string;
  isPrivate: boolean;
  /** When (epoch ms) the channel was first seen. */
  since: number;
  /** Workflowy id of the "Track #channel?" bullet, once created. */
  askNodeId?: string;
}

export interface DiscoveryState {
  /** When (epoch ms) the workspace channel list was last diffed against config.json. */
  lastRunAt?: number;
  /** Workflowy id of the "🆕 New Slack channels" bullet the questions live under. */
  inboxNodeId?: string;
  /** Keyed by Slack channel id. */
  pending?: Record<string, PendingChannel>;
}

interface StateFile {
  repos: Record<string, RepoState>;
  /** Keyed by Slack channel id. Absent in pre-Slack state files. */
  slackChannels?: Record<string, ChannelState>;
  /** Bookkeeping for the daily "new channels missing from config.json" check. */
  channelDiscovery?: DiscoveryState;
}

export const db = await JSONFilePreset<StateFile>(
  path.join(ROOT, "state.json"),
  { repos: {}, slackChannels: {} },
);
