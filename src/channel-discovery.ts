/**
 * Channel discovery: once a day, Slack channels that exist in the workspace
 * but not in config.json are found. Those matching the configured autoTrack
 * prefixes are added to config.json right away; the rest are asked about in
 * Workflowy — a "Track #channel?" bullet each, under a "🆕 New Slack channels"
 * bullet. Tagging a question #track (optionally #nobots) tracks the channel,
 * deleting it or tagging it #ignore lists it as untracked inventory. Answers
 * are applied to config.json and take effect without a restart.
 */

import {
  addSlackChannelEntries,
  discoveryConfig,
  env,
  knownSlackChannelIds,
  slackChannelEntryLine,
  type NewSlackChannelEntry,
} from "./config.ts";
import { fetchAllVisibleChannels, type SlackChannelInfo } from "./slack.ts";
import { db, type DiscoveryState, type PendingChannel } from "./state.ts";
import { errorMessage, isNodeGone } from "./util.ts";
import { createNode, deleteNode, listChildren, sameNode, type ChildNode } from "./workflowy.ts";

/** How often the workspace's channel list is diffed against config.json. */
const DISCOVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The Workflowy bullet the questions are created under. */
export const INBOX_NAME = "🆕 New Slack channels";
const INBOX_NOTE = [
  "Slack channels found in the workspace that config.json doesn't list yet. For each one below:",
  "• add the tag #track to sync it to Workflowy (#track #nobots to skip messages posted by apps)",
  "• delete the bullet, or add #ignore, to list it in config.json as untracked",
  "Answers are picked up within a poll and written to config.json.",
].join("\n");

/** True when `text` carries `#tag` as a whole tag (so #track-x doesn't count as #track). */
function hasTag(text: string | null, tag: string): boolean {
  return new RegExp(`(^|[^\\w#])#${tag}(?![\\w-])`, "i").test(text ?? "");
}

type Pending = Record<string, PendingChannel>;

/**
 * Fetches the workspace's channels and diffs them against config.json:
 * channels pending a decision that got listed meanwhile (or vanished) are
 * dropped, new autoTrack matches are written to config.json, and the other
 * new channels join the pending list.
 */
async function refreshFromSlack(state: DiscoveryState, pending: Pending): Promise<void> {
  let channels: Map<string, SlackChannelInfo>;
  try {
    channels = await fetchAllVisibleChannels();
  } catch (err) {
    console.error(`❌ Slack: channel discovery failed: ${errorMessage(err)}`);
    return;
  }
  state.lastRunAt = Date.now();

  // A pending channel that is now in config.json (added by hand) or no longer
  // visible (archived) needs no answer anymore.
  for (const [id, p] of Object.entries(pending)) {
    if (!knownSlackChannelIds.has(id) && channels.has(id)) continue;
    await removeAskBullet(p);
    delete pending[id];
  }

  const fresh = [...channels.values()]
    .filter((c) => !knownSlackChannelIds.has(c.id) && !(c.id in pending))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (fresh.length === 0) {
    console.log(`✅ Slack: no new channels — config.json covers all ${channels.size} visible channel(s).`);
    return;
  }

  const auto = fresh.filter((c) => discoveryConfig.autoTrack.some((prefix) => c.name.startsWith(prefix)));
  const ask = fresh.filter((c) => !auto.includes(c));
  if (auto.length > 0) {
    const names = auto.map((c) => `#${c.name}`).join(", ");
    try {
      await addSlackChannelEntries(
        auto.map((c) => ({ id: c.id, name: c.name, isPrivate: c.isPrivate, track: true })),
        "auto-tracked",
      );
      console.log(`➕ Slack: auto-tracked ${auto.length} new channel(s) in config.json: ${names}`);
    } catch (err) {
      console.error(`❌ Slack: adding auto-tracked channels to config.json failed: ${errorMessage(err)} — asking instead.`);
      ask.push(...auto);
    }
  }
  for (const c of ask) pending[c.id] = { name: c.name, isPrivate: c.isPrivate, since: Date.now() };
  if (ask.length > 0) {
    console.log(`🆕 Slack: ${ask.length} new channel(s) to decide on: ${ask.map((c) => `#${c.name}`).join(", ")}`);
  }
}

async function removeAskBullet(p: PendingChannel): Promise<void> {
  if (p.askNodeId === undefined) return;
  try {
    await deleteNode(p.askNodeId);
  } catch (err) {
    console.warn(`⚠️  Workflowy: removing the question bullet for #${p.name} failed: ${errorMessage(err)}`);
  }
  delete p.askNodeId;
}

/**
 * The inbox bullet's current children, creating the bullet when it doesn't
 * exist yet. A deleted inbox is recreated and every pending channel is asked
 * again (their bullets died with it — that's not an answer).
 */
async function loadInbox(state: DiscoveryState, pending: Pending): Promise<ChildNode[]> {
  if (state.inboxNodeId !== undefined) {
    try {
      return await listChildren(state.inboxNodeId);
    } catch (err) {
      if (!isNodeGone(err)) throw err;
      console.log(`🗑️  Workflowy: the "${INBOX_NAME}" bullet was deleted — recreating it.`);
      for (const p of Object.values(pending)) delete p.askNodeId;
    }
  }
  state.inboxNodeId = await createNode({
    parent_id: discoveryConfig.parentId,
    name: INBOX_NAME,
    note: INBOX_NOTE,
    position: "top",
  });
  await db.write();
  return [];
}

async function createAskBullet(inboxId: string, id: string, p: PendingChannel): Promise<string> {
  return createNode({
    parent_id: inboxId,
    name: `Track #${p.name}?${p.isPrivate ? " (private)" : ""}`,
    note: [
      `Slack channel ${id}${p.isPrivate ? " (private)" : ""}`,
      "Add #track to sync it (#track #nobots skips app posts); delete this bullet or add #ignore to leave it untracked.",
    ].join("\n"),
    position: "bottom",
  });
}

interface Decision {
  id: string;
  p: PendingChannel;
  entry: NewSlackChannelEntry;
  verdict: string;
}

/** The decision a question bullet's current state expresses, if any. */
function readDecision(id: string, p: PendingChannel, node: ChildNode | undefined): Decision | undefined {
  const base = { id, name: p.name, isPrivate: p.isPrivate };
  if (node === undefined) {
    return { id, p, entry: { ...base, track: false }, verdict: "bullet deleted → listed as untracked" };
  }
  if (hasTag(node.name, "ignore")) {
    return { id, p, entry: { ...base, track: false }, verdict: "#ignore → listed as untracked" };
  }
  if (hasTag(node.name, "track")) {
    const syncBots = !hasTag(node.name, "nobots");
    return {
      id,
      p,
      entry: { ...base, track: true, syncBots },
      verdict: `#track → now tracked${syncBots ? "" : " (bots skipped)"}`,
    };
  }
  return undefined;
}

/**
 * Keeps the Workflowy inbox in step with the pending list: asks about
 * channels that have no question bullet yet, and applies answered ones to
 * config.json.
 */
async function syncInbox(state: DiscoveryState, pending: Pending): Promise<void> {
  const ids = Object.keys(pending);
  if (ids.length === 0) return;

  let children: ChildNode[];
  try {
    children = await loadInbox(state, pending);
  } catch (err) {
    console.error(`❌ Workflowy: reading the "${INBOX_NAME}" bullet failed: ${errorMessage(err)}`);
    return;
  }
  const inboxId = state.inboxNodeId;
  if (inboxId === undefined) return; // loadInbox always sets it; keeps the type-checker honest

  const decisions: Decision[] = [];
  for (const id of ids) {
    const p = pending[id];
    if (p === undefined) continue;
    if (p.askNodeId === undefined) {
      try {
        p.askNodeId = await createAskBullet(inboxId, id, p);
        await db.write();
        console.log(`❓ Workflowy: asked whether to track #${p.name} (under "${INBOX_NAME}").`);
      } catch (err) {
        console.error(`❌ Workflowy: creating the question bullet for #${p.name} failed: ${errorMessage(err)}`);
      }
      continue;
    }
    const node = children.find((n) => sameNode(n.id, p.askNodeId ?? ""));
    const decision = readDecision(id, p, node);
    if (decision !== undefined) decisions.push(decision);
  }
  if (decisions.length === 0) return;

  try {
    await addSlackChannelEntries(
      decisions.map((d) => d.entry),
      "decided in Workflowy",
    );
  } catch (err) {
    // The bullets stay as they are — the answers are re-read next poll.
    console.error(`❌ Slack: writing decided channels to config.json failed: ${errorMessage(err)}`);
    return;
  }
  for (const d of decisions) {
    console.log(`✅ #${d.p.name}: ${d.verdict}.`);
    await removeAskBullet(d.p);
    delete pending[d.id];
  }
}

/**
 * Runs the discovery cycle: the Slack diff at most once per
 * DISCOVERY_INTERVAL_MS (unless forced), then the Workflowy question/answer
 * pass every call. A failed Slack diff retries on the next poll.
 */
export async function discoverNewChannels(force = false): Promise<void> {
  if (env.SLACK_BOT_TOKEN === "") return;
  const state = (db.data.channelDiscovery ??= {});
  const pending = (state.pending ??= {});
  if (force || Date.now() - (state.lastRunAt ?? 0) >= DISCOVERY_INTERVAL_MS) {
    await refreshFromSlack(state, pending);
  }
  await syncInbox(state, pending);
  await db.write();

  if (force && Object.keys(pending).length > 0) {
    console.log(`\nPaste-ready config.json lines for the ${Object.keys(pending).length} undecided channel(s):`);
    for (const [id, p] of Object.entries(pending).sort(([, a], [, b]) => a.name.localeCompare(b.name))) {
      // Convention in config.json: customer (ext-*) channels are tracked, internal ones listed with track:false.
      console.log(`    ${slackChannelEntryLine({ id, name: p.name, isPrivate: p.isPrivate, track: p.name.startsWith("ext-") })}`);
    }
  }
}

/** One line for the poll summary while channels await a decision; undefined when none do. */
export function pendingDecisionSummary(): string | undefined {
  const pending = db.data.channelDiscovery?.pending ?? {};
  const names = Object.values(pending)
    .map((p) => `#${p.name}`)
    .sort();
  if (names.length === 0) return undefined;
  return (
    `🆕 ${names.length} Slack channel(s) awaiting your decision in Workflowy under "${INBOX_NAME}" ` +
    `(tag #track to sync, delete or #ignore to skip): ${names.join(", ")}`
  );
}
