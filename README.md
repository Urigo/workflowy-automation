# Workflowy ← GitHub Issues & Slack Channels

Automatically create a Workflowy task whenever someone opens an issue on one of
your GitHub repositories — and keep it updated as the conversation continues:

- **New issue** → a task bullet whose title links to the issue, with the
  issue description as a sub-bullet.
- **New pull request** → the same, marked with a `🔀` prefix. PRs opened by
  bots (dependabot, renovate, …) are always skipped.
- **New comment** on a tracked issue/PR → a `💬` sub-bullet under its task,
  linking to the comment.
- **New comment on an issue/PR that isn't in Workflowy yet** (e.g. one that
  predates the sync) → its task is created retroactively, with all of its
  existing comments brought along.
- **Issue/PR closed or merged** → its task is marked complete; **reopened** →
  the task is brought back.

It can also watch **Slack channels** (e.g. shared channels with customers),
treating each channel message like an issue and its thread like the issue's
comments:

- **New channel message** → a `💬` bullet under that channel's configured
  parent, with the full text in a sub-bullet when it doesn't fit the bullet
  name. The bullet text links to the original message in Slack. Bot and
  system messages (joins, pins, …) are skipped.
- **New thread reply** on a tracked message → a `💬` sub-bullet under it,
  linking to the reply in its thread.
- **New thread reply on a message that isn't in Workflowy yet** (e.g. one that
  predates the sync) → the message's bullet is created retroactively, with the
  whole thread brought along.

It works by **polling**: every few minutes the app asks GitHub for new issues
and creates a matching task in Workflowy via the official Workflowy API. No
public server, no webhooks, no hosting required — you can run it on your laptop
or any always-on machine.

## Requirements

- [Node.js](https://nodejs.org) 26 or newer (`node --version` to check).
  A [`.nvmrc`](.nvmrc) is included, so `nvm use` / `fnm use` picks the right
  version automatically.
- A GitHub token with read access to the repos you want to watch
- A Workflowy API key
- _(optional)_ A Slack bot token, if you also want to sync Slack channels

The app has **no build step** — it's written in TypeScript and Node 26 runs
the `.ts` source directly via native type stripping. The generic plumbing is
delegated to focused, well-maintained packages so the source contains only the
actual sync logic:

| Package   | Job                                                     |
| --------- | ------------------------------------------------------- |
| `octokit` | Official GitHub SDK — auth, pagination, retries         |
| `ky`      | HTTP client for the Workflowy API — timeouts, retries   |
| `envalid` | Validates `.env` config, with defaults and clear errors |
| `zod`     | Validates `config.json`                                 |
| `lowdb`   | Persists `state.json`                                   |
| `meow`    | CLI flags and `--help`                                  |
| `dotenv`  | Loads `.env`                                            |

TypeScript itself is only used for type-checking (`npm run typecheck`).

## Setup (5 minutes)

1. **Install dependencies and copy the config template:**

   ```bash
   npm install
   cp .env.example .env
   ```

2. **Get a Workflowy API key** at https://workflowy.com/api-key and paste it
   into `.env` as `WORKFLOWY_API_KEY`.

3. **Get a GitHub token** at https://github.com/settings/tokens.
   A _fine-grained_ token with **Issues: Read-only** on your repos is enough.
   Paste it into `.env` as `GITHUB_TOKEN`.

4. **Configure your repos** — copy [config.example.json](config.example.json)
   to `config.json`:

   ```json
   {
     "defaults": {
       "parentId": "inbox",
       "searchRootId": "some-node-id"
     },
     "repos": [
       { "repo": "my-org/api", "parentId": "node-id-for-api-issues" },
       { "repo": "my-org/web" }
     ]
   }
   ```

   - **`parentId`** — the Workflowy node new issue tasks are created under,
     per repo (`"inbox"` = your Workflowy Inbox). A repo without its own
     `parentId` uses `defaults.parentId`.
   - **`searchRootId`** _(optional)_ — a bullet to check before creating a
     task. Its **entire subtree** (all descendant bullets, any depth) is
     searched for an existing bullet referencing `owner/repo#123`; when found,
     that bullet is linked as the issue's task — comments and completion sync
     to it — instead of creating a duplicate. Useful when you move issue
     bullets out of the drop-off parent into project areas.
   - **`pullRequests`** _(optional, default `true`)_ — set to `false` (per
     repo or in `defaults`) to skip PR tracking for that repo. Bot-authored
     PRs are always skipped regardless.
   - Without a `config.json`, the legacy `.env` settings (`GITHUB_REPOS`,
     `WORKFLOWY_PARENT_ID`) are used instead.
   - **`CONFIG_PATH`** _(optional, in `.env`)_ — path to the config file,
     absolute or relative to the project root. Useful for keeping the config
     out of this repo — e.g. in a private sibling repo shared with your team:

     ```
     CONFIG_PATH=../workflowy-sync-config/config.json
     ```

5. **Optional — watch Slack channels.** Create a Slack app at
   https://api.slack.com/apps with the bot token scopes `channels:history`,
   `channels:read`, and `users:read` (private channels additionally need
   `groups:history` and `groups:read`), install it to your workspace, and put
   the bot token (`xoxb-…`) into `.env` as `SLACK_BOT_TOKEN`. (Without the
   token, configured channels are skipped with a warning — the GitHub sync
   keeps running.) Then invite the bot to each channel (`/invite @your-app`)
   and list the channels in `config.json`:

   ```json
   {
     "slackChannels": [
       { "channel": "C0123ABCDE", "parentId": "node-id-for-this-channel" }
     ]
   }
   ```

   - **`channel`** — the channel id (find it at the bottom of the channel's
     _About_ tab in Slack). Can also be a comma-separated list of ids
     (`"C0123ABCDE, C0456FGHIJ"`) that share the entry's other settings.
   - `config.json` may contain `//` comments — handy for noting which channel
     an id refers to: `{ "channel": "C0123ABCDE" }, // #ext-customer`
   - **`parentId`** — where the channel's message bullets go; falls back to
     `defaults.parentId`.
   - **`lookbackDays`** _(optional, default `300`)_ — how far back the channel
     history is scanned. Threads older than this stop being watched for new
     replies. To keep API volume manageable, the full window is only swept
     every 2 hours per channel; the polls in between scan the last 30 days
     (new messages and replies on recent threads appear within one poll, a
     reply on an older thread within ~2 hours).
   - Channels are synced a few at a time in parallel, and **quiet channels are
     polled less often**: a channel with no message or reply in the last 7 days
     is only checked hourly. The first message in a dormant channel therefore
     appears within the hour — and the channel is back to being checked every
     poll from then on.
   - **`track`** _(optional, default `true`)_ — set to `false` to keep a
     channel listed in the config without syncing it. Handy for maintaining a
     complete channel inventory while only tracking some of them.
   - Instead of inviting the bot channel by channel, set
     `SLACK_AUTO_JOIN=true` in `.env` (needs the `channels:join` bot scope):
     each poll, the bot joins any **public** tracked channel it isn't in yet.
     Joining posts a "joined the channel" system message everyone in the
     channel can see, so enable it deliberately. Private channels always
     need a manual `/invite`.

## Run it

No build needed — Node runs the TypeScript source directly.
(`node src/index.ts --help` shows the CLI usage.)

Poll continuously (checks every few minutes, keeps running):

```bash
npm start
# or: node src/index.ts
```

Check once and exit (handy for cron / scheduled tasks):

```bash
npm run once
# or: node src/index.ts --once
```

While developing, `npm run dev` (`node --watch src/index.ts`) restarts on save,
and `npm run typecheck` runs the TypeScript type-checker.

**First run:** existing open issues (and, for Slack, the channel's recent
messages) are recorded as a baseline and are _not_ turned into tasks, so you
won't get flooded. Only issues opened / messages posted _after_ that point
create tasks. To import everything current instead, set
`BACKFILL_EXISTING=true` before the first run.

## Keeping it running

- **Simplest:** leave `node src/index.ts` running in a terminal on an
  always-on machine.
- **Cron (macOS/Linux):** run every 5 minutes via `--once`. Use an absolute
  path to a Node 26+ binary (cron's `PATH` is minimal):

  ```
  */5 * * * * cd /Users/urigoldshtein/Developer/workflowy-sync && /usr/local/bin/node src/index.ts --once >> sync.log 2>&1
  ```

## How it avoids duplicates

Processed issue numbers, comment ids, and each issue's Workflowy node id are
stored per-repo in `state.json` — and likewise message/reply timestamps per
Slack channel. Everything is tracked **by id** — an issue, comment, message, or
reply is only recorded after its bullet is successfully created in Workflowy,
so a crash or network blip means it retries next poll rather than dropping or
duplicating anything. (A timestamp is also kept per repo/thread, but only to
narrow the GitHub comments query and skip unchanged Slack threads — it never
decides what's new.)

## Files

| File                  | Purpose                                             |
| --------------------- | --------------------------------------------------- |
| `src/index.ts`        | Entrypoint — CLI flags, startup banner, poll loop   |
| `src/config.ts`       | Loads and validates `.env` + `config.json`          |
| `src/sync.ts`         | Core logic: diff issues against state, create tasks |
| `src/slack-sync.ts`   | Same, for Slack: diff channel messages and threads  |
| `src/github.ts`       | GitHub client — fetches a repo's open issues        |
| `src/slack.ts`        | Slack client — fetches channel messages and threads |
| `src/workflowy.ts`    | Workflowy client — creates a task for an issue      |
| `src/state.ts`        | Persists which issues are already done              |
| `src/util.ts`         | Tiny shared helpers                                 |
| `tsconfig.json`       | Type-checker settings (`npm run typecheck`)         |
| `.nvmrc`              | Pins the Node version for `nvm`/`fnm`               |
| `.env`                | Your secrets & settings (never commit this)         |
| `.env.example`        | Template to copy                                    |
| `config.json`         | Your repos & Workflowy node mapping (not committed) |
| `config.example.json` | Template to copy                                    |
| `state.json`          | Auto-created; tracks which issues are done          |
