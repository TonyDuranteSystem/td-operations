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
    "client_key",
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

  it("persists prompt_version when supplied (Phase D), null otherwise", async () => {
    const withVer = await createThreadSummary("t-pv", "investigation", "title", "abc123def")
    expect(withVer?.prompt_version).toBe("abc123def")
    const without = await createThreadSummary("t-pv2", "investigation", "title")
    expect(without?.prompt_version).toBeNull()
  })

  it("persists accounts_affected when supplied (WP2), null otherwise", async () => {
    const withAccts = await createThreadSummary("t-acc", "client_audit", "title", null, ["acc-1", "contact-2"])
    expect(withAccts?.accounts_affected).toEqual(["acc-1", "contact-2"])
    const without = await createThreadSummary("t-acc2", "investigation", "title")
    expect(without?.accounts_affected).toBeNull()
  })

  it("stores the client scope for cross-thread recall isolation (WS4.1)", async () => {
    await createThreadSummary("t-ck", "client_audit", "title", null, null, "account:acct-9")
    expect((h.store[0] as Record<string, unknown>).client_key).toBe("account:acct-9")
    // No clientKey → the column is null (a non-client thread).
    await createThreadSummary("t-ck2", "investigation", "title")
    expect((h.store[1] as Record<string, unknown>).client_key).toBeNull()
  })

  it("drops empty entries from accounts_affected; all-empty → null", async () => {
    const mixed = await createThreadSummary("t-acc3", "client_audit", "title", null, ["acc-1", ""])
    expect(mixed?.accounts_affected).toEqual(["acc-1"])
    const empty = await createThreadSummary("t-acc4", "client_audit", "title", null, ["", ""])
    expect(empty?.accounts_affected).toBeNull()
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

/**
 * THE LABEL MUST FOLLOW THE CONTENT (2026-08-05, dev job 86b056b0).
 *
 * `summary_text` is rewritten on every turn, but `client_key` used to be stamped
 * once at row creation and never touched again — while cross-conversation recall
 * compares the CURRENT turn's client against that stale label. The two drifted in
 * both directions: a row labelled with nobody quietly filling with a named client's
 * business (sidebar opened off a client page, then navigated onto one), and a row
 * labelled client A holding client B's business (navigated between clients mid-chat).
 *
 * resolveThread now re-stamps the label at the same moment it writes the summary.
 */
describe("resolveThread — the client label tracks the summary it is stored next to", () => {
  it("stamps the client on a thread that began with no client", async () => {
    await createThreadSummary("11111111-1111-4111-8111-111111111111", "investigation", "t")
    expect((await getThreadSummary("11111111-1111-4111-8111-111111111111"))?.client_key).toBeNull()

    await resolveThread("11111111-1111-4111-8111-111111111111", "done", "now about client A", "account:AAA")
    expect((await getThreadSummary("11111111-1111-4111-8111-111111111111"))?.client_key).toBe("account:AAA")
  })

  it("re-points the label when the conversation moves to a different client", async () => {
    await createThreadSummary("22222222-2222-4222-8222-222222222222", "investigation", "t", null, null, "account:AAA")
    await resolveThread("22222222-2222-4222-8222-222222222222", "done", "now about client B", "account:BBB")
    const row = await getThreadSummary("22222222-2222-4222-8222-222222222222")
    // The summary is B's, so the label must be B's — otherwise this row surfaces
    // inside client A's conversations carrying client B's business.
    expect(row?.summary_text).toBe("now about client B")
    expect(row?.client_key).toBe("account:BBB")
  })

  it("CLEARS the label when the turn has no client, so it stops being recallable", async () => {
    await createThreadSummary("33333333-3333-4333-8333-333333333333", "investigation", "t", null, null, "account:AAA")
    await resolveThread("33333333-3333-4333-8333-333333333333", "done", "general question", null)
    expect((await getThreadSummary("33333333-3333-4333-8333-333333333333"))?.client_key).toBeNull()
  })

  it("leaves the label untouched when the caller does not say (undefined ≠ null)", async () => {
    await createThreadSummary("44444444-4444-4444-8444-444444444444", "investigation", "t", null, null, "account:AAA")
    await resolveThread("44444444-4444-4444-8444-444444444444", "done", "same client")
    expect((await getThreadSummary("44444444-4444-4444-8444-444444444444"))?.client_key).toBe("account:AAA")
  })

  it("still writes the summary and outcome as before", async () => {
    await createThreadSummary("55555555-5555-4555-8555-555555555555", "investigation", "t")
    await resolveThread("55555555-5555-4555-8555-555555555555", "investigation_complete", "the summary", "contact:CCC")
    const row = await getThreadSummary("55555555-5555-4555-8555-555555555555")
    expect(row?.outcome).toBe("investigation_complete")
    expect(row?.summary_text).toBe("the summary")
    expect(row?.resolved_at).toBeTruthy()
  })
})
