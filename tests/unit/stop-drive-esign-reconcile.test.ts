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
}))

vi.mock("@/lib/supabase-admin", async () => {
  const h = await import("./_stop-drive-mocks")
  return { supabaseAdmin: h.makeSupabase(state.rows, state.recorded as never) }
})
vi.mock("@/lib/operations/esign", () => ({
  flattenEnvelopeToSignedPdf: vi.fn(),
  finalizeEsignCompletion: vi.fn(),
  fileEsignSignedPdf: vi.fn(async (id: string) => { if (state.throwOn === id) throw new Error("transient"); state.filed.push(id); return { filed: true, reason: null, hasStorage: true } }),
}))
vi.mock("@/lib/esign/events", () => ({ insertEsignEvent: vi.fn(), REMINDER_SOURCE_AUTO: "auto" }))
vi.mock("@/lib/esign/deliver-reminder", () => ({ deliverReminder: vi.fn(), loadReminderTimes: vi.fn(async () => ({})), lastReopenedAt: vi.fn() }))

beforeEach(() => {
  state.filed.length = 0
  state.throwOn = null
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
})
