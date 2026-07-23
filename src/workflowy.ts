/** Workflowy client: creates/updates the bullets that mirror GitHub issues. */

import ky from "ky";
import { env } from "./config.ts";
import type { GitHubIssue, IssueComment } from "./github.ts";

const workflowy = ky.extend({
  baseUrl: "https://workflowy.com/api/v1/",
  headers: { Authorization: `Bearer ${env.WORKFLOWY_API_KEY}` },
  timeout: 30_000,
  retry: 2,
});

interface CreateNodeResponse {
  item_id: string;
}

interface NewNode {
  parent_id: string;
  name: string;
  note?: string;
  layoutMode?: string;
  position?: string;
}

/** Creates a single Workflowy node and returns its id. */
async function createNode(node: NewNode): Promise<string> {
  const { item_id } = await workflowy.post("nodes", { json: node }).json<CreateNodeResponse>();
  return item_id;
}

/** Creates the task bullet for an issue or PR; returns the created task's node id. */
export async function createWorkflowyTask(
  issue: GitHubIssue,
  repo: string,
  parentId: string,
  isPull: boolean,
): Promise<string> {
  const taskId = await createNode({
    parent_id: parentId,
    name: `${isPull ? "🔀 " : ""}${issue.title}  ·  ${repo}#${issue.number}`,
    note: [
      `${repo}#${issue.number} ${isPull ? "PR " : ""}opened by @${issue.user?.login ?? "unknown"}`,
      issue.html_url,
    ].join("\n"),
    layoutMode: env.WORKFLOWY_LAYOUT_MODE,
    position: "bottom",
  });

  // The issue description lives in a sub-bullet under the task.
  const body = issue.body?.trim();
  if (body) {
    try {
      await createNode({ parent_id: taskId, name: "Description", note: body });
    } catch (err) {
      // The task itself exists — don't fail (and later duplicate) it over the
      // description; just note what happened.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️  ${repo}#${issue.number}: task created but description sub-bullet failed: ${message}`);
    }
  }

  return taskId;
}

/** Marks a node complete (issue closed) or uncomplete (issue reopened). */
export async function setNodeCompleted(nodeId: string, completed: boolean): Promise<void> {
  await workflowy.post(`nodes/${nodeId}/${completed ? "complete" : "uncomplete"}`);
}

/** Adds one issue comment as a sub-bullet under the issue's task. */
export async function createCommentBullet(taskId: string, comment: IssueComment): Promise<void> {
  const when = comment.created_at.slice(0, 16).replace("T", " ");
  await createNode({
    parent_id: taskId,
    name: `💬 @${comment.user?.login ?? "unknown"} · ${when}`,
    note: [comment.body?.trim(), comment.html_url].filter(Boolean).join("\n\n"),
    position: "bottom",
  });
}

// ---------------------------------------------------------------------------
// Existence search: is an issue already somewhere under a configured bullet?
// ---------------------------------------------------------------------------
interface SubtreeNode {
  id: string;
  name: string | null;
  note: string | null;
}

/** Subtrees already walked this poll, keyed by root node id. */
const subtreeCache = new Map<string, SubtreeNode[]>();

/** Drop cached subtrees so the next poll sees fresh data. */
export function clearWorkflowyCache(): void {
  subtreeCache.clear();
}

async function fetchChildren(parentId: string): Promise<SubtreeNode[]> {
  const { nodes } = await workflowy
    .get("nodes", { searchParams: { parent_id: parentId } })
    .json<{ nodes: SubtreeNode[] }>();
  return nodes;
}

/** Every descendant of rootId (breadth-first), cached per poll. */
async function loadSubtree(rootId: string): Promise<SubtreeNode[]> {
  const cached = subtreeCache.get(rootId);
  if (cached) return cached;

  const all: SubtreeNode[] = [];
  const queue: string[] = [rootId];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const children = await fetchChildren(next);
    all.push(...children);
    queue.push(...children.map((c) => c.id));
  }
  subtreeCache.set(rootId, all);
  return all;
}

/**
 * Searches the whole subtree under rootId for a bullet referencing
 * `repo#issueNumber` and returns its node id. Bullet names are preferred over
 * notes, so an issue mentioning another issue in its imported description
 * can't shadow the real task bullet.
 */
export async function findIssueBullet(
  rootId: string,
  repo: string,
  issueNumber: number,
): Promise<string | undefined> {
  const pattern = new RegExp(`${RegExp.escape(repo)}#${issueNumber}(?!\\d)`);
  const nodes = await loadSubtree(rootId);
  const byName = nodes.find((n) => pattern.test(n.name ?? ""));
  if (byName) return byName.id;
  return nodes.find((n) => pattern.test(n.note ?? ""))?.id;
}
