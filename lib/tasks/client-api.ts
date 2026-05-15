/**
 * Client-side wrapper for the workflow dispatcher route.
 *
 * Generates an idempotency key per intent so accidental double-clicks /
 * network retries fold into one server-side action.
 */

import type { TaskStatus } from "@/lib/tasks/types"

export interface DispatchActionParams {
  taskId: string
  actionSlug: string
  params?: Record<string, unknown>
  expectedStatus?: TaskStatus
  /**
   * Pass an explicit key for retry-the-same-intent semantics. When omitted,
   * a random key is generated — every call becomes a distinct intent.
   */
  idempotencyKey?: string
  mode?: "execute" | "preview"
}

export interface DispatchActionResult {
  ok: boolean
  /** Set on successful execute paths. */
  log_id?: string
  /** Set when the server returned an existing log row for the same key. */
  idempotency_replay?: boolean
  log_status?: "pending" | "success" | "failed" | "partial"
  next_status?: TaskStatus
  transition?: string | null
  spawned_task_id?: string | null
  side_effects?: Array<{ kind: string; detail: string; ref_id?: string }>
  /** Preview-mode payload. */
  preview?: {
    email_html?: string
    portal_message?: string
    sd_stage_change?: string
    documents?: Array<Record<string, unknown>>
  }
  side_effects_planned?: Array<{ kind: string; detail: string; ref_id?: string }>
  /** Server error message (any non-2xx surfaces this — R099). */
  error?: string
  /** HTTP status for caller routing. */
  status: number
}

function generateIdempotencyKey(): string {
  // Browser crypto if available; fall back to Math.random for SSR + jsdom tests.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

export async function dispatchTaskAction(
  args: DispatchActionParams,
): Promise<DispatchActionResult> {
  const key = args.idempotencyKey ?? generateIdempotencyKey()
  let res: Response
  try {
    res = await fetch(`/api/tasks/${args.taskId}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_slug: args.actionSlug,
        params: args.params ?? {},
        idempotency_key: key,
        expected_status: args.expectedStatus,
        mode: args.mode ?? "execute",
      }),
    })
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : "Network error",
    }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }

  // Per R099: surface the server's actual error string on non-2xx.
  if (!res.ok) {
    const errMsg =
      (body && typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : null) ?? `Request failed with status ${res.status}`
    return {
      ok: false,
      status: res.status,
      error: errMsg,
      ...(body && typeof body === "object" && body !== null
        ? (body as Partial<DispatchActionResult>)
        : {}),
    }
  }

  return {
    ok: true,
    status: res.status,
    ...(body && typeof body === "object" && body !== null
      ? (body as Partial<DispatchActionResult>)
      : {}),
  }
}
