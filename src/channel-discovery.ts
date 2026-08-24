/** Daily check for Slack channels that exist in the workspace but not in config.json. */

import { env, knownSlackChannelIds } from "./config.ts";
import { fetchAllVisibleChannels, type SlackChannelInfo } from "./slack.ts";
import { db } from "./state.ts";
import { errorMessage } from "./util.ts";

/** How often the workspace's channel list is diffed against config.json. */
const DISCOVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A paste-ready config.json line, following the file's conventions. */
function suggestionLine(c: SlackChannelInfo): string {
  // Convention in config.json: customer (ext-*) channels are tracked,
  // internal ones are listed with track:false as inventory.
  const tracked = c.name.startsWith("ext-");
  const priv = c.isPrivate ? " (private)" : "";
  return `    { "channel": "${c.id}"${tracked ? "" : ', "track": false'} }, // #${c.name}${priv}`;
}

/**
 * Lists channels that aren't in config.json yet (not even as track:false) and
 * prints paste-ready config lines for them. Runs at most once per
 * DISCOVERY_INTERVAL_MS unless forced; a failed run retries on the next poll.
 */
export async function discoverNewChannels(force = false): Promise<void> {
  if (env.SLACK_BOT_TOKEN === "") return;
  const state = (db.data.channelDiscovery ??= {});
  if (!force && Date.now() - (state.lastRunAt ?? 0) < DISCOVERY_INTERVAL_MS) return;

  let channels: Map<string, SlackChannelInfo>;
  try {
    channels = await fetchAllVisibleChannels();
  } catch (err) {
    console.error(`❌ Slack: channel discovery failed: ${errorMessage(err)}`);
    return;
  }
  state.lastRunAt = Date.now();
  await db.write();

  const fresh = [...channels.values()]
    .filter((c) => !knownSlackChannelIds.has(c.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (fresh.length === 0) {
    if (force) {
      console.log(`✅ Slack: no new channels — config.json covers all ${channels.size} visible channel(s).`);
    }
    return;
  }

  console.log(
    `🆕 Slack: ${fresh.length} channel(s) not in config.json yet — paste under "slackChannels" ` +
      `(keep "track": false to list one without syncing):`,
  );
  for (const c of fresh) console.log(suggestionLine(c));
}
