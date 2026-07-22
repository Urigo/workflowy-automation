/** Workflowy client: creates a task (plus description sub-bullet) for a GitHub issue. */

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

/** Creates the task bullet for an issue; returns the created task's node id. */
export async function createWorkflowyTask(issue: GitHubIssue, repo: string): Promise<string> {
  const taskId = await createNode({
    parent_id: env.WORKFLOWY_PARENT_ID,
    name: `${issue.title}  ·  ${repo}#${issue.number}`,
    note: [
      `${repo}#${issue.number} opened by @${issue.user?.login ?? "unknown"}`,
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
