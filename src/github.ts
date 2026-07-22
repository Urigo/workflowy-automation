/** GitHub client: fetches the open issues of a repository. */

import { Octokit } from "octokit";
import { env } from "./config.ts";

const octokit = new Octokit({ auth: env.GITHUB_TOKEN });

/** Exact issue type from octokit's response — no hand-written approximation. */
export type GitHubIssue = Awaited<ReturnType<typeof fetchOpenIssues>>[number];

export async function fetchOpenIssues(repo: string) {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    console.error(`⚠️  Skipping malformed repo entry "${repo}" (expected "owner/name").`);
    return [];
  }
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo: name,
    state: "open",
    per_page: 100,
  });
  // The issues endpoint also returns pull requests; filter them out.
  return issues.filter((i) => !i.pull_request);
}
