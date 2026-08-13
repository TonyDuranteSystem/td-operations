/**
 * Card 4a39e0fd round 2 — quarantine auto-reprocess (Antonio's ruling: a
 * client must never sit stuck behind a format staff already approved).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const MARKER = "FORMAT_CONFIRMATION_NEEDED:"

const state = {
  failedJobs: [] as Array<Record<string, unknown>>,
  liveForPath: new Map<string, boolean>(),
  cancels: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const filters: Record<string, unknown> = {}
      const b: Record<string, unknown> = {}
      let op: "select" | "update" | "insert" = "select"
      b.select = () => b
      b.update = (payload: Record<string, unknown>) => { op = "update"; filters.payload = payload; return b }
      b.insert = (row: Record<string, unknown>) => { state.inserts.push(row); return Promise.resolve({ error: null }) }
      b.eq = (col: string, v: unknown) => { filters[col] = v; return b }
      b.in = () => b
      b.not = () => b
      b.limit = () => {
        const path = filters["payload->>path"] as string
        return Promise.resolve({ data: state.liveForPath.get(path) ? [{ id: "live" }] : [], error: null })
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        if (op === "update") {
          state.cancels.push(filters)
          return Promise.resolve({ data: [{ id: "old-1" }], error: null }).then(resolve)
        }
        return Promise.resolve({ data: state.failedJobs, error: null }).then(resolve)
      }
      return b
    },
  },
}))

import { requeueQuarantinedPortalIngests, quarantineMarkerOf } from "@/lib/tax/quarantine-requeue"

const qJob = (path: string, mappingId: string, jobType = "ingest_bank_statement") => ({
  id: `j-${path}`,
  job_type: jobType,
  account_id: "acc-1",
  related_entity_type: jobType === "ingest_workspace_statement" ? "pnl_workspace" : null,
  related_entity_id: jobType === "ingest_workspace_statement" ? "ws-1" : null,
  payload: jobType === "ingest_workspace_statement"
    ? { workspace_id: "ws-1", path }
    : { account_id: "acc-1", tax_year: 2025, path, bank_label: "QB" },
  result: { steps: [{ detail: `${MARKER}{"file":"f.csv","mapping_id":"${mappingId}"}` }] },
})

beforeEach(() => {
  state.failedJobs = []
  state.liveForPath.clear()
  state.cancels.length = 0
  state.inserts.length = 0
})

describe("quarantineMarkerOf", () => {
  it("parses the marker, null without one, {} on garbage JSON", () => {
    expect(quarantineMarkerOf(qJob("p", "m1"))?.mapping_id).toBe("m1")
    expect(quarantineMarkerOf({ result: { steps: [{ detail: "ingest: boom" }] } })).toBeNull()
    expect(quarantineMarkerOf({ result: { steps: [{ detail: `${MARKER}not-json` }] } })).toEqual({})
  })
})

describe("requeueQuarantinedPortalIngests", () => {
  it("cancels the old quarantined jobs and enqueues ONE fresh job per path with the original payload", async () => {
    state.failedJobs = [qJob("tax/acc-1/2025/a_f.csv", "map-1"), qJob("tax/acc-1/2025/b_g.csv", "map-1")]
    const r = await requeueQuarantinedPortalIngests("map-1")
    expect(r).toEqual({ requeued: 2, cancelled: 2, skipped: 0 })
    expect(state.inserts).toHaveLength(2)
    const first = state.inserts[0] as { job_type: string; payload: { path: string; bank_label: string }; created_by: string }
    expect(first.job_type).toBe("ingest_bank_statement")
    expect(first.payload.bank_label).toBe("QB")
    expect(first.created_by).toBe("format_confirm")
  })

  it("only touches jobs quarantined for THIS mapping", async () => {
    state.failedJobs = [qJob("tax/acc-1/2025/a_f.csv", "map-OTHER")]
    const r = await requeueQuarantinedPortalIngests("map-1")
    expect(r).toEqual({ requeued: 0, cancelled: 0, skipped: 0 })
    expect(state.inserts).toHaveLength(0)
  })

  it("skips enqueue (but still cancels) when a live job already exists for the path", async () => {
    state.failedJobs = [qJob("tax/acc-1/2025/a_f.csv", "map-1")]
    state.liveForPath.set("tax/acc-1/2025/a_f.csv", true)
    const r = await requeueQuarantinedPortalIngests("map-1")
    expect(r.requeued).toBe(0)
    expect(r.skipped).toBe(1)
    expect(r.cancelled).toBe(1)
  })

  it("plain failed jobs (no marker) are never requeued by a format confirm", async () => {
    state.failedJobs = [{ id: "j", account_id: "acc-1", payload: { path: "p", tax_year: 2025 }, result: { steps: [{ detail: "ingest: could not read" }] } }]
    const r = await requeueQuarantinedPortalIngests("map-1")
    expect(r).toEqual({ requeued: 0, cancelled: 0, skipped: 0 })
  })

  it("also recovers WORKSPACE-quarantined files (an EC confirm must not strand the workspace pipeline)", async () => {
    state.failedJobs = [qJob("pnl-workspaces/ws-1/a_f.csv", "map-1", "ingest_workspace_statement")]
    const r = await requeueQuarantinedPortalIngests("map-1")
    expect(r.requeued).toBe(1)
    const ins = state.inserts[0] as { job_type: string; related_entity_id: string | null; payload: { workspace_id?: string } }
    expect(ins.job_type).toBe("ingest_workspace_statement")
    expect(ins.related_entity_id).toBe("ws-1")
    expect(ins.payload.workspace_id).toBe("ws-1")
  })
})
