import { describe, it, expect } from "vitest"
import { advance, composeNote, enqueue, isReactivation, isRetriableFailure, nextStep, shortHash, MAX_RETRIES, type Deps, type Item, type Note, type ReactFacts } from "@/lib/crm-store/reactivation"
import { reactivationAllowed } from "@/lib/crm-store/go-live"

const base: ReactFacts = {
  status: "Active", excluded: false, hasLiveOwner: false, hasAnyOwner: false, hasDoneCopy: false, openCopyRunId: null, incompleteRunId: null,
  failedFiles: 0, retriableFiles: 0, retries: 0, openMoveRun: false, hasDriveFolder: true, documentCount: 5,
}

describe("isReactivation", () => {
  it("only Closed / Cancelled / Offboarding / Delinquent back to Active", () => {
    for (const o of ["Closed", "Cancelled", "Offboarding", "Delinquent"]) expect(isReactivation(o, "Active")).toBe(true)
    expect(isReactivation("Suspended", "Active")).toBe(false)
    expect(isReactivation("Pending Formation", "Active")).toBe(false)
    expect(isReactivation(null, "Active")).toBe(false)
    expect(isReactivation("Closed", "Suspended")).toBe(false)
  })
})

describe("reactivationAllowed", () => {
  it("is off unless STORE_REACTIVATION is exactly 1, and independent of STORE_GO_LIVE", () => {
    expect(reactivationAllowed({})).toBe(false)
    expect(reactivationAllowed({ STORE_GO_LIVE: "1" })).toBe(false)
    expect(reactivationAllowed({ STORE_REACTIVATION: "true" })).toBe(false)
    expect(reactivationAllowed({ STORE_REACTIVATION: "1" })).toBe(true)
  })
})

describe("nextStep", () => {
  it("stops when the company is no longer Active or is the test company", () => {
    expect(nextStep({ ...base, status: "Closed" })).toBe("abandon")
    expect(nextStep({ ...base, excluded: true })).toBe("abandon")
  })
  it("a company that already has a live storage brings nothing in (reactivated twice)", () => {
    expect(nextStep({ ...base, hasLiveOwner: true, hasAnyOwner: true })).toBe("already_in_storage")
    expect(nextStep({ ...base, hasLiveOwner: true, hasAnyOwner: true, openCopyRunId: "r" })).toBe("already_in_storage")
  })
  it("waits while another move is open", () => expect(nextStep({ ...base, openMoveRun: true })).toBe("wait_other_move"))
  it("no Drive folder: empty storage only when nothing exists at all, otherwise a person looks", () => {
    expect(nextStep({ ...base, hasDriveFolder: false, documentCount: 0 })).toBe("empty_storage")
    expect(nextStep({ ...base, hasDriveFolder: false, documentCount: 3 })).toBe("needs_person_no_folder")
    expect(nextStep({ ...base, hasDriveFolder: false, documentCount: 0, hasAnyOwner: true })).toBe("needs_person_no_folder")
  })
  it("a fresh company starts the copy; an open copy continues; a finished copy goes live", () => {
    expect(nextStep(base)).toBe("start_copy")
    expect(nextStep({ ...base, hasAnyOwner: true, openCopyRunId: "r" })).toBe("continue_copy")
    expect(nextStep({ ...base, hasAnyOwner: true, hasDoneCopy: true })).toBe("go_live")
  })
  it("a copy with failed files is retried a few times, then a person is asked", () => {
    const inc = { ...base, hasAnyOwner: true, incompleteRunId: "r", failedFiles: 2, retriableFiles: 2 }
    expect(nextStep(inc)).toBe("retry_failed")
    expect(nextStep({ ...inc, retries: MAX_RETRIES })).toBe("needs_person_copy")
    expect(nextStep({ ...inc, retriableFiles: 0 })).toBe("needs_person_copy")
  })
})

describe("composeNote / helpers", () => {
  it("a waiting note's key carries no free text and is stable per reason", () => {
    const a = composeNote("waiting", { why: "An SS-4 or signing request is open for this company — wait until it is signed." })
    const b = composeNote("waiting", { why: "An SS-4 or signing request is open for this company — wait until it is signed." })
    const c = composeNote("waiting", { why: "something else" })
    expect(a.key).toBe(b.key)
    expect(a.key).not.toBe(c.key)
    expect(a.key).toMatch(/^waiting-[a-z0-9]+$/)
    expect(shortHash("x")).toBe(shortHash("x"))
  })
  it("the done note states the counts, the Google Docs left behind, the years and the storage check", () => {
    const n = composeNote("done", { stored: 12, reused: 9, created: 3, archived: 4, leftAsIs: 2, skippedNames: ["Plan.gdoc"], years: [2023, 2024], findings: ["A member is not linked"] })
    const text = n.lines.join(" ")
    expect(n.key).toBe("done")
    expect(text).toContain("12 files stored")
    expect(text).toContain("4 old records archived")
    expect(text).toContain("Plan.gdoc")
    expect(text).toContain("2023, 2024")
    expect(text).toContain("1 thing to look at")
    expect(composeNote("done", { stored: 0, reused: 0, created: 0, archived: 0 }).lines.join(" ")).toContain("nothing to flag")
  })
  it("too-large files are not retried", () => {
    expect(isRetriableFailure("Too large for the new storage (60 MB)")).toBe(false)
    expect(isRetriableFailure("socket hang up")).toBe(true)
  })
})

describe("enqueue", () => {
  const now = new Date("2026-10-18T12:00:00Z")
  const ev = (id: string, o: string | null, n: string | null, at: string) => ({ id, account_id: "a1", old_status: o, new_status: n, created_at: at })
  it("adds each reactivation once, ignores other changes and old history", () => {
    const names = new Map([["a1", "Acme LLC"]])
    const s1 = enqueue({ items: [], lockUntil: null }, [ev("e1", "Closed", "Active", "2026-10-17T10:00:00Z"), ev("e2", "Active", "Suspended", "2026-10-17T11:00:00Z"), ev("e0", "Closed", "Active", "2026-09-01T10:00:00Z")], names, now)
    expect(s1.items.map((i) => i.eventId)).toEqual(["e1"])
    const s2 = enqueue(s1, [ev("e1", "Closed", "Active", "2026-10-17T10:00:00Z")], names, now)
    expect(s2.items).toHaveLength(1)
    const s3 = enqueue(s2, [ev("e3", "Cancelled", "Active", "2026-10-17T13:00:00Z")], names, now)
    expect(s3.items.map((i) => i.eventId)).toEqual(["e1", "e3"]) // reactivated twice = two events, the second one lands on "already in storage"
  })
})

// ── the step runner with a fake world
function world(all: Partial<Omit<Deps, "facts">> & { facts?: (n: number) => ReactFacts } = {}) {
  const { facts: factsOf, ...over } = all
  const log: string[] = []
  const notes: Note[] = []
  let calls = 0
  const deps: Deps = {
    facts: async (_a, retries) => { const f = factsOf ? factsOf(calls++) : base; return { ...f, retries } },
    startCopy: async () => { log.push("startCopy"); return { runId: "r1", files: 7 } },
    continueCopy: async () => { log.push("continueCopy"); return { status: "done", pending: 0, skippedNames: [] } },
    requeueFailed: async () => { log.push("requeue"); return 1 },
    failedReasons: async () => ["a.pdf: boom"],
    planGoLive: async () => ({ blockers: [], planHash: "h" }),
    goLive: async () => { log.push("goLive"); return { ok: true, message: "ok", blockers: [], stored: 5, reused: 3, created: 2, archived: 1, leftAsIs: 0 } },
    emptyStorage: async () => { log.push("empty") },
    afterSwitch: async () => { log.push("after"); return { years: [2024], findings: [] } },
    skippedNames: async () => [],
    note: async (_i, n) => { notes.push(n); return true },
    now: () => Date.now(),
    ...over,
  } as Deps
  return { deps, log, notes }
}
const item = (): Item => ({ eventId: "e1", accountId: "a1", company: "Acme LLC", status: "running", retries: 0, notes: [], startedAt: "", updatedAt: "" })

describe("advance", () => {
  it("copy → switch → tax years + storage check → done, with a start note and a done note", async () => {
    const seq: ReactFacts[] = [base, { ...base, hasAnyOwner: true, openCopyRunId: "r1" }, { ...base, hasAnyOwner: true, hasDoneCopy: true }]
    const w = world({ facts: (n) => seq[Math.min(n, seq.length - 1)] })
    const r = await advance(item(), w.deps, 60_000)
    expect(w.log).toEqual(["startCopy", "continueCopy", "goLive", "after"])
    expect(r.status).toBe("done")
    expect(w.notes.map((n) => n.key)).toEqual(["start", "done"])
    expect(r.notes).toEqual(["start", "done"])
  })
  it("a second run adds nothing: already in storage → one 'already' note only the first time", async () => {
    const w = world({ facts: () => ({ ...base, hasLiveOwner: true, hasAnyOwner: true }) })
    const r1 = await advance(item(), w.deps, 60_000)
    expect(r1.status).toBe("done")
    expect(w.notes.map((n) => n.key)).toEqual(["already"])
    const r2 = await advance({ ...r1, status: "running" }, w.deps, 60_000)
    expect(w.notes).toHaveLength(1)
    expect(r2.notes).toEqual(["already"])
    expect(w.log).toEqual([])
  })
  it("a switch blocked by an open signing waits, says why once, and does not switch", async () => {
    const w = world({ facts: () => ({ ...base, hasAnyOwner: true, hasDoneCopy: true }), planGoLive: async () => ({ blockers: ["An SS-4 or signing request is open for this company — wait until it is signed."], planHash: null }) })
    const r1 = await advance(item(), w.deps, 60_000)
    const r2 = await advance(r1, w.deps, 60_000)
    expect(r2.status).toBe("running")
    expect(w.log).not.toContain("goLive")
    expect(w.notes).toHaveLength(1)
    expect(w.notes[0].key).toMatch(/^waiting-/)
  })
  it("a copy stopped by a failure is resumed (failed files re-queued), never switched half-way", async () => {
    const seq: ReactFacts[] = [
      { ...base, hasAnyOwner: true, incompleteRunId: "r1", failedFiles: 1, retriableFiles: 1 },
      { ...base, hasAnyOwner: true, openCopyRunId: "r1" },
      { ...base, hasAnyOwner: true, hasDoneCopy: true },
    ]
    const w = world({ facts: (n) => seq[Math.min(n, seq.length - 1)] })
    const r = await advance(item(), w.deps, 60_000)
    expect(w.log).toEqual(["requeue", "continueCopy", "goLive", "after"])
    expect(r.retries).toBe(1)
    expect(r.status).toBe("done")
  })
  it("failed files that never recover ask a person and do not switch", async () => {
    const w = world({ facts: () => ({ ...base, hasAnyOwner: true, incompleteRunId: "r1", failedFiles: 1, retriableFiles: 0 }) })
    const r = await advance(item(), w.deps, 60_000)
    expect(r.status).toBe("needs_person")
    expect(w.log).toEqual([])
    expect(w.notes[0].key).toBe("needs_person")
    expect(w.notes[0].lines.join(" ")).toContain("a.pdf: boom")
  })
  it("no Drive folder and no documents → an empty storage; with documents → a person looks", async () => {
    const w1 = world({ facts: () => ({ ...base, hasDriveFolder: false, documentCount: 0 }) })
    expect((await advance(item(), w1.deps, 60_000)).status).toBe("done")
    expect(w1.log).toEqual(["empty"])
    const w2 = world({ facts: () => ({ ...base, hasDriveFolder: false, documentCount: 4 }) })
    expect((await advance(item(), w2.deps, 60_000)).status).toBe("needs_person")
    expect(w2.log).toEqual([])
  })
  it("a company that is no longer Active is dropped with a note and nothing is done", async () => {
    const w = world({ facts: () => ({ ...base, status: "Closed" }) })
    const r = await advance(item(), w.deps, 60_000)
    expect(r.status).toBe("skipped")
    expect(w.log).toEqual([])
    expect(w.notes[0].key).toBe("abandoned")
  })
  it("an error counts as a retry, and after the limit a person is asked", async () => {
    const w = world({ startCopy: async () => { throw new Error("Drive said no") } })
    let it = item()
    for (let i = 0; i < MAX_RETRIES; i++) it = await advance(it, w.deps, 60_000)
    expect(it.status).toBe("needs_person")
    expect(w.notes.map((n) => n.key)).toEqual(["needs_person"])
    expect(w.notes[0].lines.join(" ")).toContain("Drive said no")
  })
  it("a note that could not be posted is tried again next run (not recorded as posted)", async () => {
    let ok = false
    const w = world({ facts: () => ({ ...base, hasLiveOwner: true, hasAnyOwner: true }), note: async () => ok })
    const r1 = await advance(item(), w.deps, 60_000)
    expect(r1.notes).toEqual([])
    ok = true
    const r2 = await advance(r1, w.deps, 60_000)
    expect(r2.notes).toEqual(["already"])
  })
})
