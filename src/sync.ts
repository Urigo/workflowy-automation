/** Core sync logic: diff issues/comments against seen-state, create bullets, persist. */

import { env, repos } from "./config.ts";
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
import { createCommentBullet, createWorkflowyTask, setNodeCompleted } from "./workflowy.ts";

interface SyncCounts {
  tasks: number;
  comments: number;
  completed: number;
  reopened: number;
}

const zeroCounts = (): SyncCounts => ({ tasks: 0, comments: 0, completed: 0, reopened: 0 });

/**
 * Creates the Workflowy task for an issue, imports every comment the issue
 * already has, and records it all in state. Returns the number of comments
 * imported.
 */
async function trackIssue(repo: string, repoState: RepoState, issue: GitHubIssue): Promise<number> {
  const taskId = await createWorkflowyTask(issue, repo);
  (repoState.taskIds ??= {})[issue.number] = taskId;
  if (!repoState.seen.includes(issue.number)) repoState.seen.push(issue.number);
  repoState.initialized = true;
  // Persist immediately so a crash never re-creates the task.
  await db.write();
  console.log(`✅ ${repo}#${issue.number} → Workflowy task created: "${issue.title}"`);

  if (issue.comments === 0) return 0;

  // Bring over all comments the issue already has.
  const seenComments = (repoState.seenComments ??= []);
  let imported = 0;
  try {
    for (const comment of await fetchIssueComments(repo, issue.number)) {
      if (seenComments.includes(comment.id)) continue;
      await createCommentBullet(taskId, comment);
      seenComments.push(comment.id);
      imported += 1;
      await db.write();
    }
    console.log(`💬 ${repo}#${issue.number}: imported ${imported} existing comment(s).`);
  } catch (err) {
    // The task exists; missing comments shouldn't fail (and later duplicate) it.
    console.warn(`⚠️  ${repo}#${issue.number}: importing comments failed: ${errorMessage(err)}`);
  }
  return imported;
}

/** Creates tasks (and imports comments) for issues we haven't seen before. */
async function syncNewIssues(
  repo: string,
  repoState: RepoState,
  issues: GitHubIssue[],
): Promise<SyncCounts> {
  const seen = new Set(repoState.seen);
  // Process oldest first so tasks appear in chronological order.
  const fresh = issues.filter((i) => !seen.has(i.number)).reverse();

  const counts = zeroCounts();
  for (const issue of fresh) {
    try {
      counts.comments += await trackIssue(repo, repoState, issue);
      counts.tasks += 1;
    } catch (err) {
      // Leave it unseen so we retry on the next poll.
      console.error(`❌ Failed to create task for ${repo}#${issue.number}: ${errorMessage(err)}`);
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
  repo: string,
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

  for (const comment of await fetchRepoComments(repo, since)) {
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
        // the initial baseline): create the task and import all comments.
        counts.comments += await trackIssue(repo, repoState, issue);
        counts.tasks += 1;
      } else {
        await createCommentBullet(taskId, comment);
        seenComments.push(comment.id);
        counts.comments += 1;
        await db.write();
        console.log(`💬 ${repo}#${issueNumber}: comment by @${comment.user?.login ?? "unknown"} added.`);
      }
      if (comment.updated_at > watermark) watermark = comment.updated_at;
    } catch (err) {
      // Stop before advancing the watermark past this comment so the next
      // poll fetches and retries it (seenComments dedupes the rest).
      console.error(`❌ Failed to sync comment on ${repo}#${issueNumber}: ${errorMessage(err)}`);
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
  repo: string,
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
        console.log(`↩️  ${repo}#${issueNumber} reopened → Workflowy task uncompleted.`);
      } else if (!isOpen && !isCompleted) {
        // Vanished from the open list — confirm it's actually closed
        // (and not, say, transferred) before completing the task.
        const issue = await fetchIssue(repo, issueNumber);
        if (issue?.state !== "closed") continue;
        await setNodeCompleted(taskId, true);
        completed.push(issueNumber);
        counts.completed += 1;
        await db.write();
        console.log(`☑️  ${repo}#${issueNumber} closed → Workflowy task completed.`);
      }
    } catch (err) {
      // Leave state untouched so this issue is retried on the next poll.
      console.error(`❌ Failed to update completion for ${repo}#${issueNumber}: ${errorMessage(err)}`);
    }
  }
  return counts;
}

function addCounts(target: SyncCounts, add: SyncCounts): void {
  target.tasks += add.tasks;
  target.comments += add.comments;
  target.completed += add.completed;
  target.reopened += add.reopened;
}

async function syncRepo(repo: string): Promise<SyncCounts> {
  const repoState = (db.data.repos[repo] ??= { initialized: false, seen: [] });

  const issues = await fetchOpenIssues(repo);
  const issuesByNumber = new Map(issues.map((i) => [i.number, i]));

  if (!repoState.initialized && !env.BACKFILL_EXISTING) {
    // First time we see this repo: record existing issues as a baseline
    // instead of flooding Workflowy with every open issue.
    repoState.initialized = true;
    repoState.seen = issues.map((i) => i.number);
    repoState.commentsSince = new Date().toISOString();
    await db.write();
    console.log(`📌 ${repo}: baseline set (${issues.length} existing open issue(s) marked as seen).`);
    return zeroCounts();
  }

  const counts = zeroCounts();
  addCounts(counts, await syncNewIssues(repo, repoState, issues));
  addCounts(counts, await syncComments(repo, repoState, issuesByNumber));
  addCounts(counts, await syncClosedIssues(repo, repoState, issuesByNumber));
  return counts;
}

export async function runOnce(): Promise<void> {
  const total = zeroCounts();
  for (const repo of repos) {
    try {
      addCounts(total, await syncRepo(repo));
    } catch (err) {
      console.error(`❌ Error syncing ${repo}: ${errorMessage(err)}`);
    }
  }
  const stamp = new Date().toISOString();
  const parts = [
    ...(total.tasks > 0 ? [`${total.tasks} new task(s)`] : []),
    ...(total.comments > 0 ? [`${total.comments} comment(s)`] : []),
    ...(total.completed > 0 ? [`${total.completed} completed`] : []),
    ...(total.reopened > 0 ? [`${total.reopened} reopened`] : []),
  ];
  if (parts.length > 0) console.log(`[${stamp}] Done — ${parts.join(", ")}.`);
  else console.log(`[${stamp}] Checked ${repos.length} repo(s) — nothing new.`);
}
