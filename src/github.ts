/** GitHub client: fetches open issues and issue comments. */

import { Octokit } from "octokit";
import { env } from "./config.ts";

const octokit = new Octokit({ auth: env.GITHUB_TOKEN });

/** Exact issue/PR item type from octokit's response — no hand-written approximation. */
export type GitHubIssue = Awaited<ReturnType<typeof fetchOpenItems>>["issues"][number];

/** Exact comment type from octokit's response. */
export type IssueComment = Awaited<ReturnType<typeof fetchIssueComments>>[number];

function parseRepo(repo: string): { owner: string; name: string } | undefined {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    console.error(`⚠️  Skipping malformed repo entry "${repo}" (expected "owner/name").`);
    return undefined;
  }
  return { owner, name };
}

/**
 * All open issues AND pull requests of a repo, in one paginated fetch —
 * the issues endpoint returns both, distinguished by the pull_request marker.
 */
export async function fetchOpenItems(repo: string) {
  const parsed = parseRepo(repo);
  if (!parsed) return { issues: [], pulls: [] };
  const items = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner: parsed.owner,
    repo: parsed.name,
    state: "open",
    per_page: 100,
  });
  return {
    issues: items.filter((i) => !i.pull_request),
    pulls: items.filter((i) => i.pull_request),
  };
}

/** True for GitHub bot accounts (dependabot, renovate, github-actions, …). */
export function isBot(user: GitHubIssue["user"]): boolean {
  return user?.type === "Bot" || (user?.login.endsWith("[bot]") ?? false);
}

/** All comments of a single issue, oldest first. */
export async function fetchIssueComments(repo: string, issueNumber: number) {
  const parsed = parseRepo(repo);
  if (!parsed) return [];
  return octokit.paginate(octokit.rest.issues.listComments, {
    owner: parsed.owner,
    repo: parsed.name,
    issue_number: issueNumber,
    per_page: 100,
  });
}

/**
 * All issue comments of a repo updated after `since`, oldest first.
 * (Includes comments on pull requests and closed issues — callers filter.)
 */
export async function fetchRepoComments(repo: string, since: string) {
  const parsed = parseRepo(repo);
  if (!parsed) return [];
  return octokit.paginate(octokit.rest.issues.listCommentsForRepo, {
    owner: parsed.owner,
    repo: parsed.name,
    since,
    sort: "updated",
    direction: "asc",
    per_page: 100,
  });
}

/** One issue's current state — used to confirm a vanished issue was closed. */
export async function fetchIssue(repo: string, issueNumber: number) {
  const parsed = parseRepo(repo);
  if (!parsed) return undefined;
  const { data } = await octokit.rest.issues.get({
    owner: parsed.owner,
    repo: parsed.name,
    issue_number: issueNumber,
  });
  return data;
}

/** Extracts the issue number from a comment's issue_url. */
export function issueNumberFromUrl(issueUrl: string): number | undefined {
  const match = /\/issues\/(\d+)$/.exec(issueUrl);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}
