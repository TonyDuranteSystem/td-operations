/**
 * Unit tests for lib/jobs/questions-ready-notify.ts (Phase B, 2026-07-08)
 * and the pure save-notification builder in lib/tax/workspace-save.ts.
 *
 * notifyQuestionsReady gates:
 *  - remaining <= 0 → skipped (nothing to decide)
 *  - no OPEN tax_returns row (data_received=false) for account+year → skipped
 *    (the portal financials page only serves open years — the deep link would
 *    bounce to /portal)
 *  - both gates pass → dispatches the action-required package with a
 *    year-scoped, questions-focused link
 *  - dispatch failure → notified:false, never throws
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const fixtures = { openReturnCount: 1 as number | null }

vi.mock("@/lib/supabase-admin", () => {
  const makeBuilder = () => {
    const b: Record<string, unknown> = {}
    const chain = () => b
    b.select = chain
    b.eq = chain
    b.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve({ count: fixtures.openReturnCount, error: null }).then(onFulfilled)
    return b
  }
  return { supabaseAdmin: { from: () => makeBuilder() } }
})

import { notifyQuestionsReady } from "@/lib/jobs/questions-ready-notify"
import { buildSaveToClientNotification } from "@/lib/tax/workspace-save"

describe("notifyQuestionsReady", () => {
  const dispatches: Array<Record<string, unknown>> = []
  const notifyFn = vi.fn(async (p: Record<string, unknown>) => {
    dispatches.push(p)
    return { dispatched: true }
  })

  beforeEach(() => {
    fixtures.openReturnCount = 1
    dispatches.length = 0
    notifyFn.mockClear()
  })

  it("skips when nothing is open for decision", async () => {
    const r = await notifyQuestionsReady({ accountId: "a1", taxYear: 2024, remaining: 0, notifyFn })
    expect(r).toEqual({ notified: false, reason: "nothing_open" })
    expect(notifyFn).not.toHaveBeenCalled()
  })

  it("skips negative/NaN remaining", async () => {
    expect((await notifyQuestionsReady({ accountId: "a1", taxYear: 2024, remaining: -3, notifyFn })).notified).toBe(false)
    expect((await notifyQuestionsReady({ accountId: "a1", taxYear: 2024, remaining: NaN, notifyFn })).notified).toBe(false)
    expect(notifyFn).not.toHaveBeenCalled()
  })

  it("skips when the year is not open in tax_returns", async () => {
    fixtures.openReturnCount = 0
    const r = await notifyQuestionsReady({ accountId: "a1", taxYear: 2024, remaining: 5, notifyFn })
    expect(r).toEqual({ notified: false, reason: "no_open_return" })
    expect(notifyFn).not.toHaveBeenCalled()
  })

  it("dispatches with a year-scoped questions link when gates pass", async () => {
    const r = await notifyQuestionsReady({ accountId: "a1", taxYear: 2024, remaining: 7, notifyFn })
    expect(r).toEqual({ notified: true })
    expect(dispatches).toHaveLength(1)
    const d = dispatches[0]
    expect(d.account_id).toBe("a1")
    expect(d.link).toBe("/portal/tax-financials?year=2024#needs-your-decision")
    const msg = d.message as { en: string; it: string }
    expect(msg.en).toContain("7")
    expect(msg.it).toContain("7")
    const title = d.title as { en: string; it: string }
    expect(title.en).toContain("2024")
  })

  it("never throws on dispatch failure", async () => {
    const failing = vi.fn(async () => { throw new Error("smtp down") })
    const r = await notifyQuestionsReady({ accountId: "a1", taxYear: 2024, remaining: 2, notifyFn: failing })
    expect(r).toEqual({ notified: false, reason: "exception" })
  })
})

describe("buildSaveToClientNotification", () => {
  it("produces year-scoped bilingual copy with the picker deep link", () => {
    const n = buildSaveToClientNotification(2024)
    expect(n.link).toBe("/portal/tax-financials?year=2024")
    expect(n.title.en).toContain("2024")
    expect(n.title.it).toContain("2024")
    expect(n.message.en).toContain("confirm")
    expect(n.message.it).toContain("conferma")
  })

  it("distinct years produce distinct dedup scopes (links differ)", () => {
    expect(buildSaveToClientNotification(2024).link).not.toBe(buildSaveToClientNotification(2025).link)
  })
})
