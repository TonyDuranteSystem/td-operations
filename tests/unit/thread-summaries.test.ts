/**
 * Hermes ↔ Claude bridge — Phase C: thread summaries.
 * Pairs with lib/ai-agent/thread-summaries.ts.
 *
 * Two halves:
 *   1. Pure search/filter logic (threadMatchesQuery, filterThreadSummaries) — no DB.
 *   2. CRUD (createThreadSummary idempotent, resolveThread, getThreadSummary,
 *      searchThreads) against a stateful in-memory supabase mock.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── stateful in-memory thread_summaries store ────────────────────────────────
const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store: any[] = []
  return { store }
})

vi.mock("@/lib/supabase-admin", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const matchesFilters = (r: any, filters: Record<string, unknown>) =>
    Object.entries(filters).every(([k, v]) => r[k] === v)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const matchesContains = (r: any, contains: Record<string, unknown[]>) =>
    Object.entries(contains).every(([k, arr]) => {
      const have = new Set((r[k] ?? []) as unknown[])
      return arr.every((x) => have.has(x))
    })

  const COLS = [
    "thread_id", "thread_type", "created_at", "resolved_at", "title", "outcome",
    "files_changed", "tasks_created", "accounts_affected", "summary_text", "tags", "prompt_version",
  ]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fill = (row: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = {}
    for (const c of COLS) out[c] = row[c] ?? null
    return out
  }

  function makeBuilder() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = { op: "select", filters: {}, contains: {}, row: null, patch: null, orderAsc: true, limitN: null }

    const runList = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let rows = h.store.filter((r: any) => matchesFilters(r, state.filters) && matchesContains(r, state.contains))
      rows = rows.slice().sort((a, b) => {
        const cmp = String(a.created_at) < String(b.created_at) ? -1 : 1
        return state.orderAsc ? cmp : -cmp
      })
      if (state.limitN != null) rows = rows.slice(0, state.limitN)
      return { data: rows.map(fill), error: null }
    }

    const runSingle = (allowNull: boolean) => {
      if (state.op === "insert") {
        if (h.store.find((r) => r.thread_id === state.row.thread_id)) {
          return { data: null, error: { code: "23505", message: "duplicate key" } }
        }
        const newRow = fill({ created_at: "2026-06-04T00:00:00Z", ...state.row })
        h.store.push(newRow)
        return { data: newRow, error: null }
      }
      if (state.op === "update") {
        const target = h.store.find((r) => matchesFilters(r, state.filters))
        if (!target) return { data: allowNull ? null : null, error: null }
        Object.assign(target, state.patch)
        return { data: fill(target), error: null }
      }
      // select
      const found = h.store.find((r) => matchesFilters(r, state.filters))
      return { data: found ? fill(found) : null, error: null }
    }

    const api = {
      select: () => api,
      insert: (row: Record<string, unknown>) => { state.op = "insert"; state.row = row; return api },
      update: (patch: Record<string, unknown>) => { state.op = "update"; state.patch = patch; return api },
      eq: (col: string, val: unknown) => { state.filters[col] = val; return api },
      contains: (col: string, arr: unknown[]) => { state.contains[col] = arr; return api },
      order: (_col: string, opts?: { ascending?: boolean }) => { state.orderAsc = opts?.ascending !== false; return api },
      limit: (n: number) => { state.limitN = n; return api },
      single: async () => runSingle(false),
      maybeSingle: async () => runSingle(true),
      // awaitable for searchThreads (terminal is .limit() then await)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then: (resolve: any, reject: any) => Promise.resolve(runList()).then(resolve, reject),
    }
    return api
  }

  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (table !== "thread_summaries") throw new Error(`unexpected table ${table}`)
        return makeBuilder()
      },
    },
  }
})

import {
  createThreadSummary,
  resolveThread,
  getThreadSummary,
  searchThreads,
  threadMatchesQuery,
  filterThreadSummaries,
  type ThreadSummary,
} from "@/lib/ai-agent/thread-summaries"

beforeEach(() => {
  h.store.length = 0
})

// ── pure search/filter ───────────────────────────────────────────────────────
function row(p: Partial<ThreadSummary> & { thread_id: string }): ThreadSummary {
  return {
    thread_type: "investigation",
    created_at: "2026-06-04T00:00:00Z",
    resolved_at: null,
    title: null,
    outcome: null,
    files_changed: null,
    tasks_created: null,
    accounts_affected: null,
    summary_text: null,
    tags: null,
    prompt_version: null,
    ...p,
  }
}

describe("threadMatchesQuery (pure)", () => {
  const r = row({
    thread_id: "t1",
    title: "Tax return mismatch for Uxio",
    thread_type: "bug_report",
    tags: ["tax", "mismatch"],
    accounts_affected: ["acc-123"],
    outcome: "investigation_complete",
    summary_text: "The 1120 totals did not reconcile.",
  })

  it("matches on title, type, tags, account id, outcome, summary (case-insensitive)", () => {
    expect(threadMatchesQuery(r, "tax return")).toBe(true)
    expect(threadMatchesQuery(r, "BUG_REPORT")).toBe(true)
    expect(threadMatchesQuery(r, "mismatch")).toBe(true)
    expect(threadMatchesQuery(r, "acc-123")).toBe(true)
    expect(threadMatchesQuery(r, "reconcile")).toBe(true)
  })

  it("empty query matches everything", () => {
    expect(threadMatchesQuery(r, "")).toBe(true)
    expect(threadMatchesQuery(r, "   ")).toBe(true)
  })

  it("non-matching query returns false", () => {
    expect(threadMatchesQuery(r, "banking")).toBe(false)
  })
})

describe("filterThreadSummaries (pure)", () => {
  const rows = [
    row({ thread_id: "t1", title: "alpha", thread_type: "bug_report", tags: ["x"], created_at: "2026-06-01T00:00:00Z" }),
    row({ thread_id: "t2", title: "beta", thread_type: "client_audit", tags: ["x", "y"], created_at: "2026-06-02T00:00:00Z" }),
    row({ thread_id: "t3", title: "alpha two", thread_type: "bug_report", tags: ["y"], created_at: "2026-06-03T00:00:00Z" }),
  ]

  it("filters by type", () => {
    const out = filterThreadSummaries(rows, "", { type: "bug_report" })
    expect(out.map((r) => r.thread_id).sort()).toEqual(["t1", "t3"])
  })

  it("requires ALL tags", () => {
    expect(filterThreadSummaries(rows, "", { tags: ["x", "y"] }).map((r) => r.thread_id)).toEqual(["t2"])
    expect(filterThreadSummaries(rows, "", { tags: ["y"] }).map((r) => r.thread_id).sort()).toEqual(["t2", "t3"])
  })

  it("applies free-text query + returns newest first", () => {
    const out = filterThreadSummaries(rows, "alpha")
    expect(out.map((r) => r.thread_id)).toEqual(["t3", "t1"]) // newest first
  })

  it("respects limit", () => {
    expect(filterThreadSummaries(rows, "", { limit: 1 })).toHaveLength(1)
  })
})

// ── CRUD against the mock ─────────────────────────────────────────────────────
describe("createThreadSummary (idempotent)", () => {
  it("creates a row with coerced type + title", async () => {
    const created = await createThreadSummary("t-1", "bug_report", "Some title")
    expect(created?.thread_id).toBe("t-1")
    expect(created?.thread_type).toBe("bug_report")
    expect(created?.title).toBe("Some title")
    expect(h.store).toHaveLength(1)
  })

  it("coerces an unknown type to the default (investigation)", async () => {
    const created = await createThreadSummary("t-2", "garbage")
    expect(created?.thread_type).toBe("investigation")
  })

  it("returns the EXISTING row on a duplicate id (no second insert)", async () => {
    await createThreadSummary("t-dup", "investigation", "first")
    const again = await createThreadSummary("t-dup", "bug_report", "second")
    expect(h.store).toHaveLength(1)
    expect(again?.title).toBe("first") // existing row, not overwritten
    expect(again?.thread_type).toBe("investigation")
  })

  it("returns null for a falsy thread id", async () => {
    expect(await createThreadSummary("", "investigation")).toBeNull()
    expect(h.store).toHaveLength(0)
  })
})

describe("getThreadSummary", () => {
  it("reads back a created row, null when absent", async () => {
    await createThreadSummary("t-get", "client_audit", "title")
    expect((await getThreadSummary("t-get"))?.thread_type).toBe("client_audit")
    expect(await getThreadSummary("missing")).toBeNull()
  })
})

describe("resolveThread", () => {
  it("stamps resolved_at, outcome and summary on an existing thread", async () => {
    await createThreadSummary("t-res", "investigation", "title")
    const resolved = await resolveThread("t-res", "investigation_complete", "One paragraph summary.")
    expect(resolved?.resolved_at).toBeTruthy()
    expect(resolved?.outcome).toBe("investigation_complete")
    expect(resolved?.summary_text).toBe("One paragraph summary.")
  })

  it("returns null when the thread row does not exist", async () => {
    expect(await resolveThread("nope", "x", "y")).toBeNull()
  })
})

describe("searchThreads (DB path)", () => {
  beforeEach(async () => {
    await createThreadSummary("s1", "bug_report", "Tax return mismatch")
    await createThreadSummary("s2", "client_audit", "Banking onboarding audit")
    await createThreadSummary("s3", "bug_report", "Lease rendering bug")
  })

  it("free-text query matches title across rows", async () => {
    const { rows } = await searchThreads("tax return")
    expect(rows.map((r) => r.thread_id)).toEqual(["s1"])
  })

  it("type filter narrows results", async () => {
    const { rows } = await searchThreads("", { type: "bug_report" })
    expect(rows.map((r) => r.thread_id).sort()).toEqual(["s1", "s3"])
  })

  it("empty query lists all (newest first), reports not truncated", async () => {
    const res = await searchThreads("")
    expect(res.rows).toHaveLength(3)
    expect(res.truncated).toBe(false)
  })

  it("flags truncated when the scan cap is hit", async () => {
    const res = await searchThreads("", { scanLimit: 2 })
    expect(res.truncated).toBe(true)
    expect(res.scanned).toBe(2)
  })
})
