import { describe, it, expect } from "vitest"
import { claimSend, finishClaim, abandonClaim, type ClaimDeps, type ClaimRow } from "@/lib/fax/send-claim"

function mem(over: Partial<{ failList: boolean; failInsert: boolean; failUpdate: number; failInsertRecord: number; raceRow: ClaimRow | null }> = {}) {
  const rows: ClaimRow[] = []
  let n = 0, updFails = over.failUpdate ?? 0, recFails = over.failInsertRecord ?? 0
  const deps: ClaimDeps = {
    listBySendId: async (sid) => over.failList ? { rows: [], error: "db down" } : { rows: rows.filter((r) => (r.details as { send_id?: string }).send_id === sid), error: null },
    listRecentSame: async (f, h) => over.failList ? { rows: [], error: "db down" } : { rows: rows.filter((r) => (r.details as { faxno?: string; content_hash?: string }).faxno === f && (r.details as { content_hash?: string }).content_hash === h), error: null },
    insertClaim: async (row) => {
      if (over.failInsert) return { id: null, error: "db down" }
      const r: ClaimRow = { id: `c${++n}`, action_type: String(row.action_type), created_at: "2026-10-20T10:00:00Z", details: row.details as Record<string, unknown> }
      rows.push(r)
      if (over.raceRow) rows.push(over.raceRow)   // another tab's claim lands right after ours
      return { id: r.id, error: null }
    },
    remove: async (id) => { const k = rows.findIndex((r) => r.id === id); if (k >= 0) rows.splice(k, 1); return { error: null } },
    update: async (id, patch) => { if (updFails > 0) { updFails--; return { error: "update failed" } } const r = rows.find((x) => x.id === id)!; Object.assign(r, { action_type: patch.action_type, details: patch.details }); return { error: null } },
    insertRecord: async (row) => { if (recFails > 0) { recFails--; return { id: null, error: "insert failed" } } rows.push({ id: `r${++n}`, action_type: String(row.action_type), created_at: "t", details: row.details as Record<string, unknown> }); return { id: `r${n}`, error: null } },
  }
  return { rows, deps }
}
const input = { sendId: "send-0001-aaaa", faxno: "8552151627", hash: "h1", confirmResend: false, actor: "luca", summary: "s", serviceDeliveryId: null }

describe("claimSend — one fax per Send", () => {
  it("a clean send gets a claim row BEFORE anything is sent", async () => {
    const m = mem()
    const r = await claimSend(input, m.deps)
    expect(r).toMatchObject({ ok: true }); expect(m.rows).toHaveLength(1)
    expect(m.rows[0]).toMatchObject({ action_type: "fax_claim", details: { send_id: "send-0001-aaaa", faxno: "8552151627", content_hash: "h1", claim: "pending" } })
  })
  it("a second try with the same send_id while the first is running or was interrupted is refused (in progress)", async () => {
    const m = mem(); await claimSend(input, m.deps)
    const r = await claimSend(input, m.deps)
    expect(r).toMatchObject({ ok: false, status: 409, code: "in_progress" }); expect(m.rows).toHaveLength(1)
  })
  it("after the fax was recorded as sent, the same send_id gives 'already sent' with the job", async () => {
    const m = mem(); const c = await claimSend(input, m.deps) as { claimId: string }
    await finishClaim(c.claimId, { actor: "l", account_id: null, service_delivery_id: null, summary: "s", record_id: null, details: { send_id: "send-0001-aaaa", faxno: "8552151627", content_hash: "h1", job_id: "J7" } }, m.deps)
    const r = await claimSend(input, m.deps)
    expect(r).toMatchObject({ ok: false, status: 409, code: "already_sent", prior: { job_id: "J7" } }); expect(r.ok === false && r.error).toMatch(/WAS already sent \(job J7\)/)
  })
  it("a page reload (new send_id) with the same number + file is refused unless the user confirms", async () => {
    const m = mem(); const c = await claimSend(input, m.deps) as { claimId: string }
    await finishClaim(c.claimId, { actor: "l", account_id: null, service_delivery_id: null, summary: "s", record_id: null, details: { send_id: "send-0001-aaaa", faxno: "8552151627", content_hash: "h1", job_id: "J7" } }, m.deps)
    const again = await claimSend({ ...input, sendId: "send-0002-bbbb" }, m.deps)
    expect(again).toMatchObject({ ok: false, status: 409, code: "recent_duplicate", prior: { job_id: "J7" } })
    expect(await claimSend({ ...input, sendId: "send-0002-bbbb", confirmResend: true }, m.deps)).toMatchObject({ ok: true })
  })
  it("a different file or a different number is not blocked", async () => {
    const m = mem(); await claimSend(input, m.deps)
    expect((await claimSend({ ...input, sendId: "send-0003-cccc", hash: "h2" }, m.deps)).ok).toBe(true)
    expect((await claimSend({ ...input, sendId: "send-0004-dddd", faxno: "3055551212" }, m.deps)).ok).toBe(true)
  })
  it("two tabs at the same moment: the one that sees the other's claim steps aside and removes its own", async () => {
    const m = mem({ raceRow: { id: "other", action_type: "fax_claim", created_at: "t", details: { send_id: "send-0001-aaaa", faxno: "8552151627", content_hash: "h1" } } })
    const r = await claimSend(input, m.deps)
    expect(r).toMatchObject({ ok: false, code: "in_progress" }); expect(r.ok === false && r.error).toMatch(/same moment/)
    expect(m.rows.map((x) => x.id)).toEqual(["other"])
  })
  it("a lookup error or a claim write error STOPS the send (never fails open)", async () => {
    const a = await claimSend(input, mem({ failList: true }).deps)
    expect(a).toMatchObject({ ok: false, status: 503, code: "lookup_failed" }); expect(a.ok === false && a.error).toMatch(/NOT sent/)
    const b = await claimSend(input, mem({ failInsert: true }).deps)
    expect(b).toMatchObject({ ok: false, status: 503, code: "claim_failed" }); expect(b.ok === false && b.error).toMatch(/NOT sent/)
  })
  it("a send without a send_id still gets the number + file check", async () => {
    const m = mem(); await claimSend({ ...input, sendId: null }, m.deps)
    expect(await claimSend({ ...input, sendId: null }, m.deps)).toMatchObject({ ok: false, code: "in_progress" })
  })
  it("abandoning the claim (Faxage refused) lets the same send be tried again", async () => {
    const m = mem(); const c = await claimSend(input, m.deps) as { claimId: string }
    await abandonClaim(c.claimId, m.deps)
    expect((await claimSend(input, m.deps)).ok).toBe(true)
  })
})

describe("finishClaim — the record of an irreversible fax", () => {
  const rec = { actor: "l", account_id: "a", service_delivery_id: null, summary: "s", record_id: "d", details: { job_id: "J" } }
  it("the claim becomes the fax_sent row", async () => {
    const m = mem(); const c = await claimSend(input, m.deps) as { claimId: string }
    expect(await finishClaim(c.claimId, rec, m.deps)).toEqual({ via: "update", id: c.claimId, error: null }); expect(m.rows[0].action_type).toBe("fax_sent")
  })
  it("one failed update is retried", async () => {
    const m = mem({ failUpdate: 1 }); const c = await claimSend(input, m.deps) as { claimId: string }
    expect((await finishClaim(c.claimId, rec, m.deps)).via).toBe("update")
  })
  it("the update keeps failing: the completed row is inserted instead", async () => {
    const m = mem({ failUpdate: 2 }); const c = await claimSend(input, m.deps) as { claimId: string }
    expect((await finishClaim(c.claimId, rec, m.deps)).via).toBe("insert")
    expect(m.rows.filter((r) => r.action_type === "fax_sent")).toHaveLength(1)
  })
  it("nothing can be written: the answer says so (the route raises the alarm)", async () => {
    const m = mem({ failUpdate: 2, failInsertRecord: 2 }); const c = await claimSend(input, m.deps) as { claimId: string }
    expect(await finishClaim(c.claimId, rec, m.deps)).toEqual({ via: "none", id: null, error: "insert failed" })
  })
  it("no claim id (the claim could not be kept): the row is inserted", async () => {
    const m = mem()
    expect((await finishClaim(null, rec, m.deps)).via).toBe("insert")
  })
})
