/**
 * Card 4a39e0fd W9 — staff unlock of the failed-file hard block.
 * Reason mandatory, override written to the RESOLVED submission, history
 * entry recorded, client chat note emitted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const state = {
  sub: { id: "sub-1", financials_meta: null as Record<string, unknown> | null, review_history: [] as unknown[] },
  updates: [] as Array<Record<string, unknown>>,
  chatEvents: [] as Array<Record<string, unknown>>,
  logs: [] as Array<Record<string, unknown>>,
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {}
      b.update = (payload: Record<string, unknown>) => { state.updates.push(payload); return b }
      b.eq = () => b
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve)
      return b
    },
  },
}))
vi.mock("@/lib/tax/resolve-submission", () => ({
  resolveClientSubmission: async () => state.sub,
}))
vi.mock("@/lib/mcp/action-log", () => ({
  logAction: (e: Record<string, unknown>) => { state.logs.push(e) },
}))
vi.mock("@/lib/portal/chat-events", () => ({
  emitClientChatEvent: async (e: Record<string, unknown>) => { state.chatEvents.push(e); return { emitted: true } },
}))

import { unlockFinancialsConfirm } from "@/lib/tax/confirm-unlock"

beforeEach(() => {
  state.sub = { id: "sub-1", financials_meta: null, review_history: [] }
  state.updates.length = 0
  state.chatEvents.length = 0
  state.logs.length = 0
})

describe("unlockFinancialsConfirm", () => {
  it("refuses without a real reason (the ruling: reason REQUIRED)", async () => {
    const r = await unlockFinancialsConfirm({ accountId: "a", taxYear: 2025, reason: "ok", actor: "x" })
    expect(r.ok).toBe(false)
    expect(state.updates).toHaveLength(0)
    expect(state.chatEvents).toHaveLength(0)
  })

  it("writes the override + history, logs, and notifies the client", async () => {
    const r = await unlockFinancialsConfirm({
      accountId: "a", taxYear: 2025,
      reason: "Statement irrecoverable; totals verified by hand against the PDF.",
      actor: "luca@tonydurante.us",
    })
    expect(r.ok).toBe(true)
    const upd = state.updates[0] as { financials_meta: { failed_files_override: { by: string; reason: string } }; review_history: Array<{ event: string }> }
    expect(upd.financials_meta.failed_files_override.by).toBe("luca@tonydurante.us")
    expect(upd.review_history.some(h => h.event === "failed_files_override")).toBe(true)
    expect(state.logs).toHaveLength(1)
    expect(state.chatEvents).toHaveLength(1)
    expect(String((state.chatEvents[0] as { message: string }).message)).toContain("unlocked your confirmation")
  })
})
