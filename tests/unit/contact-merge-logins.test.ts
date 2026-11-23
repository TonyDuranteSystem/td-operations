import { describe, expect, it, vi } from "vitest"
import type { User } from "@supabase/supabase-js"
import { describeLoginChoice, loginActions, loginChoices, resolveLoginChoice } from "@/lib/contacts/merge-logins"
import { applyLoginChoice, type MergeLoginDeps } from "@/lib/operations/merge-logins"

const L = (id: string, working = true) => ({ id, working })

describe("loginChoices — what the person may choose", () => {
  it("removed contact has no login: nothing to choose, kept login stays", () => {
    expect(loginChoices([], [L("k")])).toMatchObject({ options: ["kept"], defaultChoice: "kept", mustChoose: false })
    expect(loginChoices([], [])).toMatchObject({ options: ["kept"], mustChoose: false })
  })

  it("only the removed contact has a working login: move or remove, and the person MUST choose", () => {
    expect(loginChoices([L("r")], [])).toEqual({ options: ["removed", "none"], defaultChoice: "removed", mustChoose: true, note: null })
  })

  it("only the removed contact has a login that cannot sign in: suggested 'none', no forced choice", () => {
    expect(loginChoices([L("r", false)], [])).toMatchObject({ options: ["removed", "none"], defaultChoice: "none", mustChoose: false })
  })

  it("both have one: the person MUST choose, whatever 'can sign in' says (an unused login counts as working too)", () => {
    for (const [r, k] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      expect(loginChoices([L("r", r)], [L("k", k)])).toMatchObject({ options: ["kept", "removed"], mustChoose: true })
    }
  })

  it("several logins on either side: only the old rule, with a plain note", () => {
    const a = loginChoices([L("r1"), L("r2")], [])
    expect(a.options).toEqual(["kept"])
    expect(a.note).toMatch(/more than one login/)
    expect(loginChoices([L("r")], [L("k1"), L("k2")]).options).toEqual(["kept"])
  })
})

describe("resolveLoginChoice — the choice the caller sent, checked against the pair", () => {
  it("a forced choice that is missing is refused", () => {
    const r = resolveLoginChoice(undefined, [L("r")], [])
    expect(r.ok).toBe(false)
    if ("error" in r) expect(r.error).toMatch(/Choose what happens/)
  })

  it("both have a login and nothing was chosen: refused (no silent default)", () => {
    expect(resolveLoginChoice(undefined, [L("r")], [L("k")])).toMatchObject({ ok: false })
    expect(resolveLoginChoice("", [L("r")], [L("k", false)])).toMatchObject({ ok: false })
  })

  it("a missing choice that is not forced takes the suggestion", () => {
    expect(resolveLoginChoice(undefined, [L("r", false)], [])).toEqual({ ok: true, choice: "none" })
    expect(resolveLoginChoice(undefined, [], [L("k")])).toEqual({ ok: true, choice: "kept" })
  })

  it("accepts either login when both exist", () => {
    expect(resolveLoginChoice("kept", [L("r")], [L("k")])).toEqual({ ok: true, choice: "kept" })
    expect(resolveLoginChoice("removed", [L("r")], [L("k")])).toEqual({ ok: true, choice: "removed" })
  })

  it("accepts an offered choice", () => {
    expect(resolveLoginChoice("removed", [L("r")], [])).toEqual({ ok: true, choice: "removed" })
    expect(resolveLoginChoice("none", [L("r")], [])).toEqual({ ok: true, choice: "none" })
  })

  it("refuses garbage and a choice that does not fit (e.g. 'none' while the kept contact has a login; 'removed' with two logins)", () => {
    expect(resolveLoginChoice("delete-everything", [L("r")], [])).toMatchObject({ ok: false })
    expect(resolveLoginChoice("none", [L("r")], [L("k")])).toMatchObject({ ok: false })
    expect(resolveLoginChoice("removed", [L("r1"), L("r2")], [])).toMatchObject({ ok: false })
    expect(resolveLoginChoice("removed", [], [L("k")])).toMatchObject({ ok: false })
  })
})

describe("loginActions", () => {
  it("kept: the removed logins go, the kept ones stay", () => {
    expect(loginActions("kept", [L("r")], [L("k")])).toEqual({ moveId: null, deleteIds: ["r"] })
  })
  it("removed: the removed login moves, the kept one goes", () => {
    expect(loginActions("removed", [L("r")], [L("k")])).toEqual({ moveId: "r", deleteIds: ["k"] })
    expect(loginActions("removed", [L("r")], [])).toEqual({ moveId: "r", deleteIds: [] })
  })
  it("none: the removed login goes, nothing moves", () => {
    expect(loginActions("none", [L("r")], [])).toEqual({ moveId: null, deleteIds: ["r"] })
  })
})

describe("describeLoginChoice", () => {
  it("says what happens in plain words", () => {
    expect(describeLoginChoice("removed", "r@x.com", null, "Marco", 1, 0)).toMatch(/moves to Marco.*same email and password/)
    expect(describeLoginChoice("removed", "r@x.com", "k@x.com", "Marco", 1, 1)).toMatch(/k@x.com.*deleted/)
    expect(describeLoginChoice("none", "r@x.com", null, "Marco", 1, 0)).toMatch(/no portal login/)
    expect(describeLoginChoice("kept", null, "k@x.com", "Marco", 0, 1)).toMatch(/stays/)
    expect(describeLoginChoice("kept", null, null, "Marco", 0, 0)).toBe("Neither contact has a portal login.")
  })
})

// ───── applying the choice: the ORDER is what keeps a person from being locked out ─────
const U = (id: string, contactId: string, extra: Record<string, unknown> = {}) => ({ id, email: `${id}@x.com`, app_metadata: { role: "client", contact_id: contactId, ...extra } }) as unknown as User

function deps(over: Partial<MergeLoginDeps> = {}, store: Record<string, User> = {}) {
  const calls: string[] = []
  const d: MergeLoginDeps = {
    getUser: vi.fn(async (id: string) => store[id] ?? null),
    setAppMetadata: vi.fn(async (id: string, meta: Record<string, unknown>) => { calls.push(`set:${id}`); store[id] = { ...store[id], app_metadata: meta } as User; return { error: null } }),
    deleteUser: vi.fn(async (id: string) => { calls.push(`delete:${id}`); return { error: null } }),
    keptTier: vi.fn(async () => "active"),
    ...over,
  }
  return { d, calls, store }
}

describe("applyLoginChoice", () => {
  it("'removed': re-points the login at the kept contact FIRST, keeps its other metadata, sets the kept tier, THEN deletes the kept contact's old login", async () => {
    const r = U("r", "REM", { portal_tier: "lead", suspended: false })
    const k = U("k", "KEPT")
    const { d, calls, store } = deps({}, { r, k })
    const res = await applyLoginChoice("removed", [r], [k], "KEPT", d)
    expect(calls).toEqual(["set:r", "delete:k"])
    expect(store.r.app_metadata).toMatchObject({ role: "client", contact_id: "KEPT", portal_tier: "active", suspended: false })
    expect(res).toMatchObject({ moved: "r", deleted: ["k"], deleteFailed: [], error: null })
  })

  it("'removed' with no kept login: moves it and deletes nothing", async () => {
    const r = U("r", "REM")
    const { d, calls } = deps({}, { r })
    const res = await applyLoginChoice("removed", [r], [], "KEPT", d)
    expect(calls).toEqual(["set:r"])
    expect(res).toMatchObject({ moved: "r", deleted: [], error: null })
  })

  it("a failed move deletes NOTHING, is tried twice, and reports which login is stranded", async () => {
    const r = U("r", "REM")
    const k = U("k", "KEPT")
    const set = vi.fn(async () => ({ error: "boom" }))
    const { d, calls } = deps({ setAppMetadata: set }, { r, k })
    const res = await applyLoginChoice("removed", [r], [k], "KEPT", d)
    expect(calls).toEqual([])
    expect(set).toHaveBeenCalledTimes(2)
    expect(res.error).toMatch(/could not be moved/)
    expect(res.deleted).toEqual([])
    expect(res.stranded).toEqual({ loginId: "r", fromContactId: "REM", toContactId: "KEPT" })
  })

  it("a move that fails once and works on the retry succeeds (and then deletes the other login)", async () => {
    const r = U("r", "REM")
    const k = U("k", "KEPT")
    const store: Record<string, User> = { r, k }
    let n = 0
    const { d, calls } = deps({ setAppMetadata: vi.fn(async (id: string, meta: Record<string, unknown>) => { n++; if (n === 1) return { error: "blip" }; store[id] = { ...store[id], app_metadata: meta } as User; return { error: null } }) }, store)
    const res = await applyLoginChoice("removed", [r], [k], "KEPT", d)
    expect(res).toMatchObject({ moved: "r", error: null, stranded: null, deleted: ["k"] })
    expect(calls).toEqual(["delete:k"])
  })

  it("a move that cannot be read back deletes NOTHING", async () => {
    const r = U("r", "REM")
    const k = U("k", "KEPT")
    const store: Record<string, User> = { r, k }
    const { d, calls } = deps({ setAppMetadata: vi.fn(async () => ({ error: null })) }, store)   // metadata never actually changes
    const res = await applyLoginChoice("removed", [r], [k], "KEPT", d)
    expect(calls).toEqual([])
    expect(res.error).toMatch(/could not be confirmed/)
  })

  it("'kept': deletes only the removed contact's logins, moves nothing, never touches the kept login", async () => {
    const r = U("r", "REM")
    const k = U("k", "KEPT")
    const { d, calls } = deps({}, { r, k })
    const res = await applyLoginChoice("kept", [r], [k], "KEPT", d)
    expect(calls).toEqual(["delete:r"])
    expect(res).toMatchObject({ moved: null, deleted: ["r"] })
  })

  it("'none': deletes the removed login only", async () => {
    const r = U("r", "REM")
    const { d, calls } = deps({}, { r })
    const res = await applyLoginChoice("none", [r], [], "KEPT", d)
    expect(calls).toEqual(["delete:r"])
    expect(res.deleted).toEqual(["r"])
  })

  it("a delete that fails is reported, not hidden", async () => {
    const r = U("r", "REM")
    const { d } = deps({ deleteUser: vi.fn(async () => ({ error: "nope" })) }, { r })
    const res = await applyLoginChoice("kept", [r], [], "KEPT", d)
    expect(res.deleteFailed).toEqual(["r"])
    expect(res.deleted).toEqual([])
  })

  it("keeps the moved login's tier when the kept contact has no computed tier", async () => {
    const r = U("r", "REM", { portal_tier: "onboarding" })
    const { d, store } = deps({ keptTier: vi.fn(async () => null) }, { r })
    await applyLoginChoice("removed", [r], [], "KEPT", d)
    expect(store.r.app_metadata).toMatchObject({ contact_id: "KEPT", portal_tier: "onboarding" })
  })
})
