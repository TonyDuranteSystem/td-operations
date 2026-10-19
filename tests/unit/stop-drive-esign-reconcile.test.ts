/**
 * Stop Drive, slice S1c fix round (item 7): a completed e-sign envelope whose signed PDF could not be filed is genuinely
 * retried by the reconciliation cron (runEsignReminders step 0b); one already filed is a cheap no-op for the filer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  filed: [] as string[],
  throwOn: null as string | null,
  tick: null as null | (() => void),
}))

vi.mock("@/lib/supabase-admin", async () => {
  const h = await import("./_stop-drive-mocks")
  return { supabaseAdmin: h.makeSupabase(state.rows, state.recorded as never) }
})
vi.mock("@/lib/operations/esign", () => ({
  flattenEnvelopeToSignedPdf: vi.fn(),
  finalizeEsignCompletion: vi.fn(),
  fileEsignSignedPdf: vi.fn(async (id: string) => { state.recorded.push({ table: "FILER", op: "insert", payload: id }); state.tick?.(); if (state.throwOn === id) throw new Error("transient"); state.filed.push(id); return { filed: true, reason: null, hasStorage: true } }),
}))
vi.mock("@/lib/esign/events", () => ({ insertEsignEvent: vi.fn(), REMINDER_SOURCE_AUTO: "auto" }))
vi.mock("@/lib/esign/deliver-reminder", () => ({ deliverReminder: vi.fn(), loadReminderTimes: vi.fn(async () => ({})), lastReopenedAt: vi.fn() }))

beforeEach(() => {
  state.filed.length = 0
  state.throwOn = null
  state.tick = null
  state.recorded.length = 0
  for (const k of Object.keys(state.rows)) delete state.rows[k]
})

describe("runEsignReminders — re-filing completed envelopes", () => {
  it("calls the filer for each completed, unfiled envelope in the window (and a transient failure does not stop the run)", async () => {
    state.rows.esign_envelopes = [{ id: "env-a" }, { id: "env-b" }]
    state.throwOn = "env-a"
    const { runEsignReminders } = await import("@/lib/esign/reminders")
    await expect(runEsignReminders(new Date("2026-10-18T12:00:00Z"))).resolves.toBeDefined()
    expect(state.filed).toContain("env-b")
  })

  it("runs AFTER expiry and reminders, so a slow filer never delays them", async () => {
    state.rows.esign_envelopes = [{ id: "env-a" }]
    const { runEsignReminders } = await import("@/lib/esign/reminders")
    await runEsignReminders(new Date("2026-10-18T12:00:00Z"))
    const firstFiler = state.recorded.findIndex((r) => r.table === "FILER")
    const expiry = state.recorded.findIndex((r) => r.table === "esign_envelopes" && r.op === "update")
    expect(firstFiler).toBeGreaterThan(-1)
    expect(expiry).toBeGreaterThan(-1)
    expect(expiry).toBeLessThan(firstFiler)
  })

  it("is held to a time budget: when each filing is slow, only as many as fit in the budget run this time", async () => {
    state.rows.esign_envelopes = Array.from({ length: 10 }, (_, i) => ({ id: `env-${i}` }))
    const { runEsignReminders, REFILE_TIME_BUDGET_MS, REFILE_MAX_PER_RUN } = await import("@/lib/esign/reminders")
    expect(REFILE_MAX_PER_RUN).toBe(10)
    let now = 1_000_000
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now)
    state.tick = () => { now += REFILE_TIME_BUDGET_MS / 2 + 1 } // each filing "takes" just over half the budget
    try {
      await runEsignReminders(new Date("2026-10-18T12:00:00Z"))
    } finally {
      spy.mockRestore()
    }
    expect(state.filed.length).toBeGreaterThan(0)
    expect(state.filed.length).toBeLessThan(10)
    expect(state.filed.length).toBeLessThanOrEqual(3)
  })
})
