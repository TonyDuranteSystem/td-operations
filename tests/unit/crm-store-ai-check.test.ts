import { describe, it, expect, vi, beforeEach } from "vitest"
import { deriveMark, isPersonalLike, estimateUsd, EST_USD_PER_FILE, type MarkInput } from "@/lib/crm-store/understand/mark"

const tn = (s: string) => ({ office_lease: "Office Lease", passport: "Passport", operating_agreement: "Operating Agreement" } as Record<string, string>)[s] ?? s
const analysis = (over: Partial<NonNullable<MarkInput["analysis"]>> = {}) => ({ status: "judged", ai_type: "office_lease", ai_injection: false, owner_named: true, duplicate_kind: null, word_count: 500, problem: null, updated_at: "2026-09-30T22:10:00Z", ...over })
const mark = (a: MarkInput["analysis"], fileTypeSlug: string | null, twinLive = false) => deriveMark({ analysis: a, fileTypeSlug, twinLive, typeName: tn })

describe("the mark a file row shows (derived, never stored)", () => {
  it("not checked → no mark", () => expect(mark(null, "office_lease").mark).toBe("none"))
  it("the AI agrees with the file's type and nothing conflicts → looks right", () => expect(mark(analysis(), "office_lease").mark).toBe("looks_right"))
  it("'no example yet' / 'no CRM record' never turn a row red or amber by themselves", () => {
    const r = mark(analysis(), "office_lease")
    expect(r.mark).toBe("looks_right"); expect(r.reasons).toEqual([])
  })
  it("the AI disagrees with the file's current type → look at this, in words", () => {
    const r = mark(analysis({ ai_type: "operating_agreement" }), "office_lease")
    expect(r.mark).toBe("look"); expect(r.reasons[0]).toBe("Filed as Office Lease, but it looks like Operating Agreement.")
  })
  it("an untyped file the AI could type → look at this, says what it looks like", () => {
    const r = mark(analysis(), null)
    expect(r.mark).toBe("look"); expect(r.reasons[0]).toContain("Not typed yet")
  })
  it("the AI could not tell → look at this", () => expect(mark(analysis({ ai_type: null }), "office_lease").mark).toBe("look"))
  it("the text names another client, or tried to instruct the AI → a real conflict (red)", () => {
    expect(mark(analysis({ owner_named: false }), "office_lease").mark).toBe("conflict")
    expect(mark(analysis({ ai_injection: true }), "office_lease").mark).toBe("conflict")
  })
  it("a conflict is never downgraded by another, milder reason", () => expect(mark(analysis({ owner_named: false, ai_type: "passport" }), "office_lease").mark).toBe("conflict"))
  it("a look-alike whose words differ → look at this; an identical or removed twin → nothing to say", () => {
    expect(mark(analysis({ duplicate_kind: "different_words" }), "office_lease", true).mark).toBe("look")
    expect(mark(analysis({ duplicate_kind: "same_words" }), "office_lease", true).mark).toBe("looks_right")
    expect(mark(analysis({ duplicate_kind: "different_words" }), "office_lease", false).mark).toBe("looks_right")   // the twin was trashed
  })
  it("unreadable / AI not reached are 'look at this' with a plain reason, never a silent good", () => {
    expect(mark(analysis({ status: "unreadable", problem: "too large" }), "office_lease")).toMatchObject({ mark: "look", reasons: ["too large"] })
    expect(mark(analysis({ status: "read" }), "office_lease").headline).toBe("The AI could not be reached")
  })
  it("judged from a picture only (no words) is not a quiet good", () => expect(mark(analysis({ word_count: 0 }), "office_lease").mark).toBe("look"))
  it("a retype after the check changes the mark at once (the file's CURRENT type is what counts)", () => {
    const a = analysis({ ai_type: "passport" })
    expect(mark(a, "office_lease").mark).toBe("look"); expect(mark(a, "passport").mark).toBe("looks_right")
  })
})

describe("what a bulk check leaves out (personal / ID-like)", () => {
  const f = (o: Partial<Parameters<typeof isPersonalLike>[0]> = {}) => ({ documentType: "office_lease", personalSlugs: new Set(["passport"]), ownerKind: "company", folderKind: "company", mime: "application/pdf", name: "Lease.pdf", ...o })
  it("an ordinary company document is included", () => expect(isPersonalLike(f())).toBe(false))
  it("a personal type, a person's storage, or a Contacts folder is left out", () => {
    expect(isPersonalLike(f({ documentType: "passport" }))).toBe(true)
    expect(isPersonalLike(f({ ownerKind: "person" }))).toBe(true)
    expect(isPersonalLike(f({ folderKind: "contacts" }))).toBe(true)
  })
  it("an UNTYPED picture (a phone photo such as a passport) is left out; a typed one is judged by its type", () => {
    expect(isPersonalLike(f({ documentType: null, mime: "image/heic", name: "IMG_1.HEIC" }))).toBe(true)
    expect(isPersonalLike(f({ documentType: null, mime: null, name: "scan.jpeg" }))).toBe(true)
    expect(isPersonalLike(f({ documentType: "office_lease", mime: "image/png", name: "lease.png" }))).toBe(false)
  })
})

describe("the cost shown before a bulk check", () => {
  it("is about 0.4 cent per file, rounded up to the cent", () => {
    expect(EST_USD_PER_FILE).toBe(0.004)
    expect(estimateUsd(6)).toBe(0.03); expect(estimateUsd(120)).toBe(0.48); expect(estimateUsd(0)).toBe(0)
  })
})

// ── claim-before-pay ─────────────────────────────────────────────────────────────────────────
const state = vi.hoisted(() => ({ mine: { id: "B", created_at: "2026-09-30T22:00:01Z" }, oldest: "B", deleted: [] as string[], pending: 0 }))
vi.mock("@/lib/supabase-admin", () => {
  const builder = (table: string) => {
    const q: Record<string, unknown> = {}
    const self = new Proxy(q, {
      get: (_t, prop: string) => {
        if (prop === "then") return undefined
        if (prop === "data") return []
        if (prop === "error") return null
        if (prop === "insert") return () => ({ select: () => ({ single: async () => ({ data: state.mine, error: null }) }) })
        if (prop === "delete") return () => ({ eq: async (_c: string, v: string) => { state.deleted.push(v); return { error: null } } })
        if (prop === "limit") return async () => ({ data: [{ id: state.oldest }], error: null })
        if (prop === "select") return (_c: string, o?: { head?: boolean }) => (o?.head ? { eq: () => ({ gte: async () => ({ count: state.pending, error: null }) }) } : self)
        return () => self
      },
    })
    void table
    return self
  }
  return { supabaseAdmin: { from: builder } }
})

describe("a file version is claimed before it is paid for", () => {
  beforeEach(() => { state.deleted = []; state.oldest = "B"; state.pending = 0 })
  it("the oldest claim may call the AI", async () => {
    const { claimCall } = await import("@/lib/crm-store/understand/judge")
    expect(await claimCall("v1", "claude-haiku-4-5-20251001")).toBe("B")
    expect(state.deleted).toEqual([])
  })
  it("a newer claim for the SAME version removes itself and stops (no double payment)", async () => {
    const { claimCall, AiBusyError } = await import("@/lib/crm-store/understand/judge")
    state.oldest = "A"
    await expect(claimCall("v1", "m")).rejects.toBeInstanceOf(AiBusyError)
    expect(state.deleted).toEqual(["B"])
  })
  it("claims in flight count against the day's budget", async () => {
    const { spentTodayUsd } = await import("@/lib/crm-store/understand/judge")
    state.pending = 3
    const spent = await spentTodayUsd().catch(() => -1)
    expect(spent).toBeGreaterThanOrEqual(0.03 - 1e-9)
  })
})
