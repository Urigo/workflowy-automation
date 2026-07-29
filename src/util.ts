import { HTTPError } from "ky";

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when Workflowy answered 404 — the target node was deleted by the user. */
export function isNodeGone(err: unknown): boolean {
  return err instanceof HTTPError && err.response.status === 404;
}
