/**
 * The workflow dedup must be scoped to the workflow it is FOR.
 *
 * THE BUG THIS PINS (production, 2026-07-11 → 2026-07-22):
 * `itin-form-completed` deduped on `service_delivery_id` to avoid spawning two
 * "Review ITIN documents" cards. But `itin_data_collection` — the "Send wizard
 * link to client" card spawned when the ITIN service is created — carries the
 * SAME service_delivery_id in its sd_progress_v1 meta. The dedup asked "does ANY
 * workflow task carry this id?", found the send-link card, and reported
 * already_spawned. The review card was never created, and because
 * `already_spawned` marks the workflow handled, the plain-task fallback did not
 * fire either. So a client submitted their questionnaire, their W-7 / 1040-NR /
 * Schedule OI were generated, and NOBODY was told to review them.
 * Confirmed in action_log for Marcell Bogyora (×3) and Tamás Fazekas (×1).
 *
 * Two further properties pinned here, both required by review:
 *  - a CLOSED card must not suppress a new one (a re-submit overwrites the
 *    generated PDFs by stable filename, so staff must re-review or they mail
 *    the IRS a form that no longer matches Drive);
 *  - a failed dedup QUERY must fail CLOSED (the old `{ data }`-only destructure
 *    turned a transient error into "no duplicate" and spawned a second card).
 *
 * Reading the result: the dedup runs BEFORE the catalog lookup. The catalog is
 * stubbed to match nothing, so `no_trigger_match` proves the dedup let it
 * through, and `already_spawned` proves the dedup suppressed it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface TaskRow { id: string; workflow_slug: string | null; status: string }

let taskFixtures: TaskRow[] = []
let dedupError: { message: string } | null = null
/** Filters the dispatcher actually applied to the tasks query. */
let applied: { eq: Array<[string, unknown]>; in: Array<[string, unknown[]]> }

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "tasks") {
        const chain = {
          select: vi.fn(() => chain),
          eq: vi.fn((col: string, val: unknown) => { applied.eq.push([col, val]); return chain }),
          not: vi.fn(() => chain),
          in: vi.fn((col: string, vals: unknown[]) => { applied.in.push([col, vals]); return chain }),
          limit: vi.fn(() => chain),
          maybeSingle: vi.fn(() => {
            if (dedupError) return Promise.resolve({ data: null, error: dedupError })
            // Honour the filters the dispatcher applied — that is the whole point.
            const slugFilter = applied.eq.find(([c]) => c === "workflow_slug")?.[1]
            const statusFilter = applied.in.find(([c]) => c === "status")?.[1] as string[] | undefined
            const match = taskFixtures.find(t =>
              (slugFilter === undefined || t.workflow_slug === slugFilter) &&
              (statusFilter === undefined || statusFilter.includes(t.status)),
            )
            return Promise.resolve({ data: match ?? null, error: null })
          }),
        }
        return chain
      }
      // catalog_entries etc — match nothing, so we stop right after the dedup.
      const empty = {
        select: vi.fn(() => empty),
        eq: vi.fn(() => empty),
        insert: vi.fn(() => Promise.resolve({ data: null, error: null })),
        then: undefined,
      }
      return Object.assign(empty, { then: (r: (v: unknown) => void) => r({ data: [], error: null }) })
    },
  },
}))

vi.mock("@/lib/tasks/workflow-dispatch-log", () => ({ logWorkflowDispatch: vi.fn() }))

import { dispatchWorkflowForFormCompletion } from "@/lib/tasks/dispatch-workflow-for-event"

const SD_ID = "sd-1111"

function dispatch(idempotency: { field: string; value: string; workflow_slug?: string }) {
  return dispatchWorkflowForFormCompletion({
    form_table: "itin_submissions",
    submission: { id: "sub-1" },
    build_task_meta: async () => ({ service_delivery_id: SD_ID }),
    task_title: "Review ITIN documents -- Test Client",
    actor: "test",
    idempotency,
  })
}

beforeEach(() => {
  taskFixtures = []
  dedupError = null
  applied = { eq: [], in: [] }
})

describe("workflow dedup scoping", () => {
  it("a DIFFERENT workflow's card must not suppress this one — the production bug", async () => {
    // Exactly the production shape: the send-wizard-link card, already Done,
    // carrying the same service_delivery_id.
    taskFixtures = [{ id: "task-send-link", workflow_slug: "itin_data_collection", status: "Done" }]

    const res = await dispatch({ field: "service_delivery_id", value: SD_ID, workflow_slug: "itin_review" })

    expect(res.reason).not.toBe("already_spawned")
    expect(res.spawned).toBe(false) // catalog stub matches nothing
    expect(res.reason).toBe("no_trigger_match")
  })

  it("an OPEN card for the SAME workflow still suppresses — retries stay idempotent", async () => {
    taskFixtures = [{ id: "task-review", workflow_slug: "itin_review", status: "To Do" }]

    const res = await dispatch({ field: "service_delivery_id", value: SD_ID, workflow_slug: "itin_review" })

    expect(res.reason).toBe("already_spawned")
    expect(res.task_id).toBe("task-review")
  })

  it("a CLOSED card for the same workflow does NOT suppress — a re-submit needs a fresh review", async () => {
    // The client re-submits and the generated PDFs are overwritten by stable
    // filename. Without a new card staff would mail the IRS the old form.
    taskFixtures = [{ id: "task-review-old", workflow_slug: "itin_review", status: "Done" }]

    const res = await dispatch({ field: "service_delivery_id", value: SD_ID, workflow_slug: "itin_review" })

    expect(res.reason).not.toBe("already_spawned")
  })

  it("scopes by workflow AND by open status", async () => {
    await dispatch({ field: "service_delivery_id", value: SD_ID, workflow_slug: "itin_review" })

    expect(applied.eq).toContainEqual(["workflow_slug", "itin_review"])
    const statuses = applied.in.find(([c]) => c === "status")?.[1]
    expect(statuses).toEqual(expect.arrayContaining(["To Do", "In Progress", "Waiting"]))
  })

  it("a failed dedup query FAILS CLOSED — never spawn on an unverifiable check", async () => {
    dedupError = { message: "connection reset" }

    const res = await dispatch({ field: "service_delivery_id", value: SD_ID, workflow_slug: "itin_review" })

    expect(res.spawned).toBe(false)
    expect(res.reason).toBe("dedup_check_failed")
    expect(res.spawn_error).toContain("connection reset")
  })

  it("without a workflow_slug the check stays unscoped — the old behaviour, for callers that rely on it", async () => {
    // banking / tax dedup on submission_id, which no other workflow carries.
    taskFixtures = [{ id: "task-any", workflow_slug: "banking_review_payset", status: "To Do" }]

    const res = await dispatch({ field: "submission_id", value: "sub-1" })

    expect(res.reason).toBe("already_spawned")
    expect(applied.eq.find(([c]) => c === "workflow_slug")).toBeUndefined()
  })
})
