/** Workflowy client: creates a task for a GitHub issue. */

import ky from "ky";
import { env } from "./config.ts";
import type { GitHubIssue } from "./github.ts";

const workflowy = ky.extend({
  baseUrl: "https://workflowy.com/api/v1/",
  headers: { Authorization: `Bearer ${env.WORKFLOWY_API_KEY}` },
  timeout: 30_000,
  retry: 2,
});

export async function createWorkflowyTask(issue: GitHubIssue, repo: string): Promise<void> {
  await workflowy.post("nodes", {
    json: {
      parent_id: env.WORKFLOWY_PARENT_ID,
      name: `${issue.title}  ·  ${repo}#${issue.number}`,
      note: [
        `${repo}#${issue.number} opened by @${issue.user?.login ?? "unknown"}`,
        issue.html_url,
      ].join("\n"),
      layoutMode: env.WORKFLOWY_LAYOUT_MODE,
      position: "bottom",
    },
  });
}
