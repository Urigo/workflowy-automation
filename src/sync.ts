/** Core sync logic: diff issues/comments against seen-state, create bullets, persist. */

import { env, repoConfigs, type RepoConfig } from "./config.ts";
import {
  fetchIssue,
  fetchIssueComments,
  fetchOpenIssues,
  fetchRepoComments,
  issueNumberFromUrl,
  type GitHubIssue,
} from "./github.ts";
import { db, type RepoState } from "./state.ts";
import { errorMessage } from "./util.ts";
import {
  clearWorkflowyCache,
  createCommentBullet,
  createWorkflowyTask,
  findIssueBullet,
  setNodeCompleted,
} from "./workflowy.ts";

interface SyncCounts {
  tasks: number;
  linked: number;
  comments: number;
  completed: number;
  reopened: number;
}

const zeroCounts = (): SyncCounts => ({ tasks: 0, linked: 0, comments: 0, completed: 0, reopened: 0 });

function addCounts(target: SyncCounts, add: SyncCounts): void {
  target.tasks += add.tasks;
  target.linked += add.linked;
  target.comments += add.comments;
  target.completed += add.completed;
  target.reopened += add.reopened;
}

/** Records an issue as tracked (task node known, issue seen) and persists. */
async function recordIssue(repoState: RepoState, issueNumber: number, taskId: string): Promise<void> {
  (repoState.taskIds ??= {})[issueNumber] = taskId;
  if (!repoState.seen.includes(issueNumber)) repoState.seen.push(issueNumber);
  repoState.initialized = true;
  await db.write();
}

/**
 * Ensures an issue has a Workflowy task. If a bullet for it already exists
 * anywhere under the configured search root, that bullet is linked instead of
 * creating a duplicate. Newly created tasks import every comment the issue
 * already has. Returns the sync counts.
 */
async function trackIssue(cfg: RepoConfig, repoState: RepoState, issue: GitHubIssue): Promise<SyncCounts> {
  const counts = zeroCounts();
  const repo = cfg.repo;

  if (cfg.searchRootId !== undefined) {
    const existingId = await findIssueBullet(cfg.searchRootId, repo, issue.number);
    if (existingId !== undefined) {
      await recordIssue(repoState, issue.number, existingId);
      counts.linked += 1;
      console.log(`🔗 ${repo}#${issue.number} already in Workflowy → linked to existing bullet.`);
      return counts;
    }
  }

  const taskId = await createWorkflowyTask(issue, repo, cfg.parentId);
  await recordIssue(repoState, issue.number, taskId);
  counts.tasks += 1;
  console.log(`✅ ${repo}#${issue.number} → Workflowy task created: "${issue.title}"`);

  if (issue.comments === 0) return counts;

  // Bring over all comments the issue already has.
  const seenComments = (repoState.seenComments ??= []);
  try {
    for (const comment of await fetchIssueComments(repo, issue.number)) {
      if (seenComments.includes(comment.id)) continue;
      await createCommentBullet(taskId, comment);
      seenComments.push(comment.id);
      counts.comments += 1;
      await db.write();
    }
    console.log(`💬 ${repo}#${issue.number}: imported ${counts.comments} existing comment(s).`);
  } catch (err) {
    // The task exists; missing comments shouldn't fail (and later duplicate) it.
    console.warn(`⚠️  ${repo}#${issue.number}: importing comments failed: ${errorMessage(err)}`);
  }
  return counts;
}

/** Creates tasks (and imports comments) for issues we haven't seen before. */
async function syncNewIssues(
  cfg: RepoConfig,
  repoState: RepoState,
  issues: GitHubIssue[],
): Promise<SyncCounts> {
  const seen = new Set(repoState.seen);
  // Process oldest first so tasks appear in chronological order.
  const fresh = issues.filter((i) => !seen.has(i.number)).reverse();

  const counts = zeroCounts();
  for (const issue of fresh) {
    try {
      addCounts(counts, await trackIssue(cfg, repoState, issue));
    } catch (err) {
      // Leave it unseen so we retry on the next poll.
      console.error(`❌ Failed to create task for ${cfg.repo}#${issue.number}: ${errorMessage(err)}`);
    }
  }
  return counts;
}

/**
 * Syncs comment activity. New comments on tracked issues become sub-bullets;
 * a new comment on an untracked issue creates its task retroactively (with all
 * existing comments, via trackIssue). Every decision is made by comment id —
 * commentsSince only narrows the GitHub query.
 */
async function syncComments(
  cfg: RepoConfig,
  repoState: RepoState,
  issuesByNumber: Map<number, GitHubIssue>,
): Promise<SyncCounts> {
  const since = repoState.commentsSince;
  if (!since) {
    // Migration from a pre-comment-sync state file: start watching from now.
    repoState.commentsSince = new Date().toISOString();
    await db.write();
    return zeroCounts();
  }

  const seenComments = (repoState.seenComments ??= []);
  const counts = zeroCounts();
  let watermark = since;

  for (const comment of await fetchRepoComments(cfg.repo, since)) {
    const issueNumber = issueNumberFromUrl(comment.issue_url);
    const issue = issueNumber === undefined ? undefined : issuesByNumber.get(issueNumber);

    if (seenComments.includes(comment.id) || issueNumber === undefined || !issue) {
      // Already handled, or a comment on a PR / closed issue: skip it, but
      // remember the id so the skip stays cheap on future polls.
      if (!seenComments.includes(comment.id)) seenComments.push(comment.id);
      if (comment.updated_at > watermark) watermark = comment.updated_at;
      continue;
    }

    try {
      const taskId = repoState.taskIds?.[issueNumber];
      if (taskId === undefined) {
        // Comment activity on an issue with no Workflowy task (e.g. part of
        // the initial baseline): create/link the task and import all comments.
        addCounts(counts, await trackIssue(cfg, repoState, issue));
      } else {
        await createCommentBullet(taskId, comment);
        seenComments.push(comment.id);
        counts.comments += 1;
        await db.write();
        console.log(`💬 ${cfg.repo}#${issueNumber}: comment by @${comment.user?.login ?? "unknown"} added.`);
      }
      if (comment.updated_at > watermark) watermark = comment.updated_at;
    } catch (err) {
      // Stop before advancing the watermark past this comment so the next
      // poll fetches and retries it (seenComments dedupes the rest).
      console.error(`❌ Failed to sync comment on ${cfg.repo}#${issueNumber}: ${errorMessage(err)}`);
      break;
    }
  }

  if (watermark !== since) {
    repoState.commentsSince = watermark;
    await db.write();
  }
  return counts;
}

/**
 * Marks tasks complete for tracked issues that got closed, and uncompletes
 * them when an issue is reopened. A tracked issue missing from the open list
 * is confirmed via a direct fetch before its task is completed.
 */
async function syncClosedIssues(
  cfg: RepoConfig,
  repoState: RepoState,
  issuesByNumber: Map<number, GitHubIssue>,
): Promise<SyncCounts> {
  const counts = zeroCounts();
  const completed = (repoState.completedIssues ??= []);

  for (const [key, taskId] of Object.entries(repoState.taskIds ?? {})) {
    const issueNumber = Number(key);
    const isOpen = issuesByNumber.has(issueNumber);
    const isCompleted = completed.includes(issueNumber);

    try {
      if (isOpen && isCompleted) {
        // Issue was reopened: bring the task back.
        await setNodeCompleted(taskId, false);
        repoState.completedIssues = completed.filter((n) => n !== issueNumber);
        counts.reopened += 1;
        await db.write();
        console.log(`↩️  ${cfg.repo}#${issueNumber} reopened → Workflowy task uncompleted.`);
      } else if (!isOpen && !isCompleted) {
        // Vanished from the open list — confirm it's actually closed
        // (and not, say, transferred) before completing the task.
        const issue = await fetchIssue(cfg.repo, issueNumber);
        if (issue?.state !== "closed") continue;
        await setNodeCompleted(taskId, true);
        completed.push(issueNumber);
        counts.completed += 1;
        await db.write();
        console.log(`☑️  ${cfg.repo}#${issueNumber} closed → Workflowy task completed.`);
      }
    } catch (err) {
      // Leave state untouched so this issue is retried on the next poll.
      console.error(`❌ Failed to update completion for ${cfg.repo}#${issueNumber}: ${errorMessage(err)}`);
    }
  }
  return counts;
}

async function syncRepo(cfg: RepoConfig): Promise<SyncCounts> {
  const repoState = (db.data.repos[cfg.repo] ??= { initialized: false, seen: [] });

  const issues = await fetchOpenIssues(cfg.repo);
  const issuesByNumber = new Map(issues.map((i) => [i.number, i]));

  if (!repoState.initialized && !env.BACKFILL_EXISTING) {
    // First time we see this repo: record existing issues as a baseline
    // instead of flooding Workflowy with every open issue.
    repoState.initialized = true;
    repoState.seen = issues.map((i) => i.number);
    repoState.commentsSince = new Date().toISOString();
    await db.write();
    console.log(`📌 ${cfg.repo}: baseline set (${issues.length} existing open issue(s) marked as seen).`);
    return zeroCounts();
  }

  const counts = zeroCounts();
  addCounts(counts, await syncNewIssues(cfg, repoState, issues));
  addCounts(counts, await syncComments(cfg, repoState, issuesByNumber));
  addCounts(counts, await syncClosedIssues(cfg, repoState, issuesByNumber));
  return counts;
}

export async function runOnce(): Promise<void> {
  clearWorkflowyCache(); // fresh subtree searches each poll
  const total = zeroCounts();
  for (const cfg of repoConfigs) {
    try {
      addCounts(total, await syncRepo(cfg));
    } catch (err) {
      console.error(`❌ Error syncing ${cfg.repo}: ${errorMessage(err)}`);
    }
  }
  const stamp = new Date().toISOString();
  const parts = [
    ...(total.tasks > 0 ? [`${total.tasks} new task(s)`] : []),
    ...(total.linked > 0 ? [`${total.linked} linked to existing bullet(s)`] : []),
    ...(total.comments > 0 ? [`${total.comments} comment(s)`] : []),
    ...(total.completed > 0 ? [`${total.completed} completed`] : []),
    ...(total.reopened > 0 ? [`${total.reopened} reopened`] : []),
  ];
  if (parts.length > 0) console.log(`[${stamp}] Done — ${parts.join(", ")}.`);
  else console.log(`[${stamp}] Checked ${repoConfigs.length} repo(s) — nothing new.`);
}
