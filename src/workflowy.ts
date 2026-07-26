/** Workflowy client: creates/updates the bullets that mirror GitHub issues and Slack messages. */

import ky from "ky";
import { env } from "./config.ts";
import type { GitHubIssue, IssueComment } from "./github.ts";

const workflowy = ky.extend({
  baseUrl: "https://workflowy.com/api/v1/",
  headers: { Authorization: `Bearer ${env.WORKFLOWY_API_KEY}` },
  timeout: 30_000,
  // The subtree search bursts many requests — ride out 429s (Retry-After is honored).
  retry: { limit: 5, backoffLimit: 30_000 },
  hooks: {
    beforeRequest: [
      ({ request }) => {
        const url = new URL(request.url);
        const parentId = url.searchParams.get("parent_id");
        const name = parentId === null ? undefined : nodeNames.get(parentId);
        const label = name === undefined ? "" : ` ("${name}")`;
        console.log(`  ⇢ Workflowy ${request.method} ${url.pathname.replace("/api/v1/", "")}${url.search}${label}`);
      },
    ],
    beforeRetry: [
      ({ error, retryCount }) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.log(`  ↻ Workflowy retry ${retryCount}/5 — ${reason}`);
      },
    ],
  },
});

// ---------------------------------------------------------------------------
// Node names, learned from API responses so logs can show them next to ids.
// ---------------------------------------------------------------------------
const nodeNames = new Map<string, string>();

/** Remembers a node's name under its full id and its short (last-12) form. */
function rememberName(id: string, name: string | null | undefined): void {
  if (!name) return;
  const clean = name.length > 40 ? `${name.slice(0, 39)}…` : name;
  nodeNames.set(id, clean);
  nodeNames.set(id.replaceAll("-", "").slice(-12), clean);
}

/** The id, annotated with the node's name when it is known: `id "Name"`. */
export function nodeLabel(id: string): string {
  const name = nodeNames.get(id);
  return name === undefined ? id : `${id} "${name}"`;
}

/** Looks up (and caches) the names of the given node ids, for readable logs. */
export async function prefetchNodeNames(ids: string[]): Promise<void> {
  for (const id of new Set(ids)) {
    if (nodeNames.has(id) || id === "inbox") continue;
    try {
      const data = await workflowy.get(`nodes/${id}`).json<{ node?: SubtreeNode } & SubtreeNode>();
      const node = data.node ?? data;
      rememberName(id, node.name);
      if (node.id !== undefined) rememberName(node.id, node.name);
    } catch {
      // Name lookups are cosmetic — logs fall back to the bare id.
    }
  }
}

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
    // The title links to the issue/PR; "repo#number" stays plain text so the
    // existence search (findIssueBullet) keeps matching it.
    name: `${isPull ? "🔀 " : ""}<a href="${issue.html_url}">${escapeHtml(issue.title)}</a>  ·  ${repo}#${issue.number}`,
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
    // The bullet text links straight to the comment on GitHub.
    name: `💬 <a href="${comment.html_url}">@${escapeHtml(comment.user?.login ?? "unknown")} · ${when}</a>`,
    note: [comment.body?.trim(), comment.html_url].filter(Boolean).join("\n\n"),
    position: "bottom",
  });
}

/** A Slack message/reply already resolved to plain display fields. */
export interface SlackBulletContent {
  author: string;
  /** "YYYY-MM-DD HH:mm" */
  when: string;
  text: string;
  permalink: string;
}

/** How much of a message's first line becomes the bullet name. */
const SNIPPET_LENGTH = 80;

/** Escapes text embedded in the HTML markup of a bullet name. */
function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Creates the bullet for a Slack channel message; returns the created node id. */
export async function createSlackMessageBullet(
  content: SlackBulletContent,
  channelName: string,
  parentId: string,
): Promise<string> {
  const firstLine = content.text.split("\n", 1)[0] ?? "";
  const snippet = firstLine.length > SNIPPET_LENGTH ? `${firstLine.slice(0, SNIPPET_LENGTH - 1)}…` : firstLine;
  const nodeId = await createNode({
    parent_id: parentId,
    // The bullet text links straight to the original Slack message.
    name: `💬 <a href="${content.permalink}">${escapeHtml(snippet)}</a>  ·  #${channelName}`,
    note: [`#${channelName} message by @${content.author} · ${content.when}`, content.permalink].join("\n"),
    layoutMode: env.WORKFLOWY_LAYOUT_MODE,
    position: "bottom",
  });

  // Long or multi-line messages keep their full text in a sub-bullet.
  if (snippet !== content.text) {
    try {
      await createNode({ parent_id: nodeId, name: "Message", note: content.text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️  #${channelName}: bullet created but full-text sub-bullet failed: ${message}`);
    }
  }

  return nodeId;
}

/** Adds one thread reply as a sub-bullet under the message's bullet. */
export async function createSlackReplyBullet(taskId: string, content: SlackBulletContent): Promise<void> {
  await createNode({
    parent_id: taskId,
    // The bullet text links straight to the original reply in its thread.
    name: `💬 <a href="${content.permalink}">@${escapeHtml(content.author)} · ${content.when}</a>`,
    note: [content.text, content.permalink].filter(Boolean).join("\n\n"),
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
  parent_id: string | null;
}

/**
 * One flat export of the whole account — a single API call (rate-limited to
 * 1/min by Workflowy) — serves every subtree search. It is refreshed every
 * 30 minutes; a bullet moved into a search subtree within that window isn't
 * found yet (worst case: a duplicate task instead of a link).
 */
const EXPORT_CACHE_TTL_MS = 30 * 60 * 1000;

interface ExportCache {
  at: number;
  nodes: SubtreeNode[];
  childrenOf: Map<string | null, SubtreeNode[]>;
}

let exportCache: ExportCache | undefined;

/** Drop a stale export so an upcoming poll re-fetches it. */
export function clearWorkflowyCache(): void {
  if (exportCache !== undefined && Date.now() - exportCache.at > EXPORT_CACHE_TTL_MS) {
    exportCache = undefined;
  }
}

async function loadExport(): Promise<ExportCache> {
  if (exportCache !== undefined) return exportCache;

  console.log("🌲 Fetching the full Workflowy node export (one request)…");
  const { nodes } = await workflowy.get("nodes-export").json<{ nodes: SubtreeNode[] }>();
  const childrenOf = new Map<string | null, SubtreeNode[]>();
  for (const node of nodes) {
    rememberName(node.id, node.name);
    const siblings = childrenOf.get(node.parent_id);
    if (siblings === undefined) childrenOf.set(node.parent_id, [node]);
    else siblings.push(node);
  }
  exportCache = { at: Date.now(), nodes, childrenOf };
  console.log(`🌲 Export done — ${nodes.length} bullets (cached for 30 min).`);
  return exportCache;
}

/** Every descendant of rootId, filtered from the cached export in memory. */
async function loadSubtree(rootId: string): Promise<SubtreeNode[]> {
  const { nodes, childrenOf } = await loadExport();
  // The config may use Workflowy's short id form (the uuid's last 12 chars).
  const bare = rootId.replaceAll("-", "");
  const root = nodes.find((n) => n.id === rootId || n.id.replaceAll("-", "").endsWith(bare));
  if (root === undefined) {
    console.warn(`⚠️  Workflowy node "${rootId}" not found in the export — subtree search found nothing.`);
    return [];
  }

  const all: SubtreeNode[] = [];
  const queue: string[] = [root.id];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const child of childrenOf.get(next) ?? []) {
      all.push(child);
      queue.push(child.id);
    }
  }
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
