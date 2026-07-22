# Workflowy ← GitHub Issues

Automatically create a Workflowy task whenever someone opens an issue on one of
your GitHub repositories.

It works by **polling**: every few minutes the app asks GitHub for new issues
and creates a matching task in Workflowy via the official Workflowy API. No
public server, no webhooks, no hosting required — you can run it on your laptop
or any always-on machine.

## Requirements

- [Node.js](https://nodejs.org) 24 or newer (`node --version` to check).
  A [`.nvmrc`](.nvmrc) is included, so `nvm use` / `fnm use` picks the right
  version automatically.
- A GitHub token with read access to the repos you want to watch
- A Workflowy API key

The app has **no runtime dependencies**. It's written in TypeScript and compiled
to plain JavaScript that runs entirely on modern Node built-ins — `fetch`,
native `.env` loading (`process.loadEnvFile`), `import.meta.dirname`, and
`util.parseArgs`. TypeScript is only needed at build time (`npm install` pulls
it in as a dev dependency).

## Setup (5 minutes)

1. **Copy the config template:**

   ```bash
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

## Build it

Compile the TypeScript to `dist/` once (or use `npm run dev` to watch):

```bash
npm install   # first time only — installs TypeScript
npm run build
```

## Run it

Poll continuously (checks every few minutes, keeps running):

```bash
npm start
# or, after building: node dist/index.js
```

Check once and exit (handy for cron / scheduled tasks):

```bash
npm run once
# or, after building: node dist/index.js --once
```

(`npm start` and `npm run once` rebuild automatically before running.)

**First run:** existing open issues are recorded as a baseline and are *not*
turned into tasks, so you won't get flooded. Only issues opened *after* that
point create tasks. To import all current open issues instead, set
`BACKFILL_EXISTING=true` before the first run.

## Keeping it running

- **Simplest:** leave `node dist/index.js` running in a terminal on an
  always-on machine.
- **Cron (macOS/Linux):** build once, then run every 5 minutes via `--once`:

  ```
  */5 * * * * cd /Users/urigoldshtein/Developer/workflowy-sync && /usr/bin/env node dist/index.js --once >> sync.log 2>&1
  ```

## How it avoids duplicates

Processed issue numbers are stored per-repo in `state.json`. A task is only
marked "seen" after it's successfully created in Workflowy, so a crash or
network blip means it retries next poll rather than dropping the issue.

## Files

| File            | Purpose                                            |
|-----------------|----------------------------------------------------|
| `src/index.ts`  | The whole app (TypeScript source)                  |
| `dist/index.js` | Compiled output — what actually runs (`npm run build`) |
| `tsconfig.json` | TypeScript compiler settings                       |
| `.env`          | Your secrets & settings (never commit this)        |
| `.env.example`  | Template to copy                                   |
| `state.json`    | Auto-created; tracks which issues are done         |
