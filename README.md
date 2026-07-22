# Workflowy ← GitHub Issues

Automatically create a Workflowy task whenever someone opens an issue on one of
your GitHub repositories.

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

The app has **no build step** — it's written in TypeScript and Node 26 runs
the `.ts` source directly via native type stripping. The generic plumbing is
delegated to focused, well-maintained packages so the source contains only the
actual sync logic:

| Package   | Job                                                    |
|-----------|--------------------------------------------------------|
| `octokit` | Official GitHub SDK — auth, pagination, retries        |
| `ky`      | HTTP client for the Workflowy API — timeouts, retries  |
| `envalid` | Validates `.env` config, with defaults and clear errors|
| `lowdb`   | Persists `state.json`                                  |
| `meow`    | CLI flags and `--help`                                 |
| `dotenv`  | Loads `.env`                                           |

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
   A *fine-grained* token with **Issues: Read-only** on your repos is enough.
   Paste it into `.env` as `GITHUB_TOKEN`.

4. **List your repos** in `.env`, comma-separated:

   ```
   GITHUB_REPOS=my-org/api, my-org/web
   ```

5. (Optional) Choose where tasks land. By default they go to your Workflowy
   **Inbox**. To use a specific bullet instead, set `WORKFLOWY_PARENT_ID` to
   that bullet's node id.

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

**First run:** existing open issues are recorded as a baseline and are *not*
turned into tasks, so you won't get flooded. Only issues opened *after* that
point create tasks. To import all current open issues instead, set
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

Processed issue numbers are stored per-repo in `state.json`. A task is only
marked "seen" after it's successfully created in Workflowy, so a crash or
network blip means it retries next poll rather than dropping the issue.

## Files

| File               | Purpose                                            |
|--------------------|----------------------------------------------------|
| `src/index.ts`     | Entrypoint — CLI flags, startup banner, poll loop  |
| `src/config.ts`    | Loads `.env` and validates all settings            |
| `src/sync.ts`      | Core logic: diff issues against state, create tasks|
| `src/github.ts`    | GitHub client — fetches a repo's open issues       |
| `src/workflowy.ts` | Workflowy client — creates a task for an issue     |
| `src/state.ts`     | Persists which issues are already done             |
| `src/util.ts`      | Tiny shared helpers                                |
| `tsconfig.json`    | Type-checker settings (`npm run typecheck`)        |
| `.nvmrc`        | Pins the Node version for `nvm`/`fnm`              |
| `.env`          | Your secrets & settings (never commit this)        |
| `.env.example`  | Template to copy                                   |
| `state.json`    | Auto-created; tracks which issues are done         |
