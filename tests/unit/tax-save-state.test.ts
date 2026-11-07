/**
 * Approved tax questionnaire → the saved copy (dev job 7df278cd, Shipment 2): the pure rules.
 *   - the fingerprint that says "same submission or not",
 *   - the panel's state (saved / saving / failed / not needed) and the plain reason + what to do for each failure,
 *   - the earlier-copy card and the names of the copies.
 */
import { describe, it, expect } from "vitest"
import { answersFingerprint } from "@/lib/tax/answers-fingerprint"
import {
  ANSWERS_CHANGED_MESSAGE,
  CLOSED_COMPANY_NOTHING_TO_FILE,
  SAVE_RESET_META,
  approvedBy,
  classifyFailure,
  decideSaveState,
  earlierCopiesToDecide,
  earlierCopyName,
  failedFileName,
  failureText,
  readSaveMeta,
} from "@/lib/tax/save-state"

describe("answersFingerprint", () => {
  it("does not care about key order or file order", () => {
    const a = answersFingerprint({ x: 1, y: { b: 2, a: [1, 2] } }, ["p/2.pdf", "p/1.pdf"])
    const b = answersFingerprint({ y: { a: [1, 2], b: 2 }, x: 1 }, ["p/1.pdf", "p/2.pdf"])
    expect(a).toBe(b)
  })
  it("changes when an answer or a file changes", () => {
    const base = answersFingerprint({ x: "No" }, ["p/1.pdf"])
    expect(answersFingerprint({ x: "Yes" }, ["p/1.pdf"])).not.toBe(base)
    expect(answersFingerprint({ x: "No" }, ["p/1.pdf", "p/2.pdf"])).not.toBe(base)
    expect(answersFingerprint({ x: "No", y: "" }, ["p/1.pdf"])).not.toBe(base)
  })
  it("treats missing data the same as empty, and ignores non-text file entries", () => {
    expect(answersFingerprint(null, null)).toBe(answersFingerprint({}, []))
    expect(answersFingerprint({}, [null, 3, "a"])).toBe(answersFingerprint({}, ["a"]))
  })
  it("an answer left undefined reads the same as one that is absent", () => {
    expect(answersFingerprint({ a: 1, b: undefined }, [])).toBe(answersFingerprint({ a: 1 }, []))
  })
})

describe("readSaveMeta", () => {
  it("reads a damaged or empty record as 'nothing recorded'", () => {
    for (const raw of [null, undefined, "x", 3, [], { attempts: "no" }, { earlier_copy: { choice: "maybe" } }]) {
      const m = readSaveMeta(raw)
      expect(m.attempts).toBe(0)
      expect(m.lastError).toBeNull()
      expect(m.stamp).toBeNull()
      expect(m.earlierCopy).toBeNull()
      expect(m.failed).toEqual([])
    }
  })
  it("reads the fields the save job writes", () => {
    const m = readSaveMeta({
      attempts: 2, last_error: "boom", failed: ["a.pdf (download failed after 3 attempts)"], errors: ["e"], filed_in: "storage",
      summary_file_id: "store:abc", stamp: { fp: "f", at: "2026-11-07T10:00:00.000Z" },
      earlier_copy: { choice: "visible", covered: 2, at: "2026-11-07T11:00:00.000Z", by: "Luca" },
    })
    expect(m).toMatchObject({ attempts: 2, lastError: "boom", filedIn: "storage", summaryPointer: "store:abc", stamp: { fp: "f", at: "2026-11-07T10:00:00.000Z" } })
    expect(m.earlierCopy).toEqual({ choice: "visible", covered: 2, at: "2026-11-07T11:00:00.000Z", by: "Luca" })
  })
  it("a resubmit's reset gives fresh tries and a fresh alert, and keeps nothing else", () => {
    expect(SAVE_RESET_META).toEqual({ attempts: 0, last_error: null, failed: [], errors: [], sweep_alerted: false })
  })
})

describe("why a save failed", () => {
  const meta = (over: Partial<{ lastError: string | null; failed: string[]; errors: string[] }>) => ({ lastError: null, failed: [], errors: [], ...over })
  it("no storage", () => {
    expect(classifyFailure(meta({ lastError: "company c1 (Acme) has no storage and no folder — there is nowhere to archive its tax package" }))).toBe("no_storage")
    expect(failureText("no_storage", []).fix).toMatch(/Storage tab/)
  })
  it("the summary PDF could not be made", () => {
    expect(classifyFailure(meta({ lastError: "summary PDF not saved" }))).toBe("summary")
    expect(classifyFailure(meta({ lastError: "x", errors: ["Summary PDF error: boom"] }))).toBe("summary")
    expect(failureText("summary", []).fix).toMatch(/still safe/)
  })
  it("a client file could not be copied: the file's name is shown, and a long list is cut", () => {
    expect(classifyFailure(meta({ lastError: "1 file(s) failed: x", failed: ["Payset statements 2025.pdf (download failed after 3 attempts)"] }))).toBe("files")
    expect(failureText("files", ["Payset statements 2025.pdf (download failed after 3 attempts)"]).reason).toBe("1 of the client's files could not be copied: Payset statements 2025.pdf.")
    const many = ["a.pdf", "b.pdf: boom", "c.pdf", "d.pdf", "e.pdf"]
    expect(failureText("files", many).reason).toBe("5 of the client's files could not be copied: a.pdf, b.pdf, c.pdf and 2 more.")
    expect(failedFileName("b.pdf: boom")).toBe("b.pdf")
  })
  it("the client changed the answers while saving", () => {
    expect(classifyFailure(meta({ lastError: `save stale: ${ANSWERS_CHANGED_MESSAGE}` }))).toBe("changed")
  })
  it("anything else reads as storage not answering", () => {
    expect(classifyFailure(meta({ lastError: "save threw: fetch failed" }))).toBe("unreachable")
    expect(failureText("unreachable", []).fix).toMatch(/Nothing to fix/)
  })
})

describe("decideSaveState", () => {
  const meta = readSaveMeta
  const base = { reviewStatus: "confirmed", archivedAt: null as string | null, meta: meta(null), job: "none" as const, finished: false }

  it("nothing is promised before staff approve", () => {
    expect(decideSaveState({ ...base, reviewStatus: "under_review" }).state).toBe("not_released")
    expect(decideSaveState({ ...base, reviewStatus: null }).state).toBe("not_released")
  })
  it("approved + the marker set = saved", () => {
    expect(decideSaveState({ ...base, archivedAt: "2026-11-07T10:00:00Z", meta: meta({ filed_in: "storage" }) }).state).toBe("saved")
  })
  it("a closed company: nothing to file (also when the job already recorded it)", () => {
    expect(decideSaveState({ ...base, finished: true })).toEqual({ state: "not_needed", reason: CLOSED_COMPANY_NOTHING_TO_FILE })
    expect(decideSaveState({ ...base, archivedAt: "2026-11-07T10:00:00Z", meta: meta({ filed_in: "nothing" }) }).state).toBe("not_needed")
  })
  it("a save running = saving; nothing tried yet = not saved (the panel then starts it)", () => {
    expect(decideSaveState({ ...base, job: "processing" }).state).toBe("saving")
    expect(decideSaveState({ ...base, job: "pending" }).state).toBe("not_saved")
    expect(decideSaveState(base).state).toBe("not_saved")
  })
  it("a failed save says why; 'keeps trying' is true while the tries last or a job waits", () => {
    const failed = meta({ attempts: 2, last_error: "save threw: fetch failed" })
    const s = decideSaveState({ ...base, meta: failed })
    expect(s).toMatchObject({ state: "failed", kind: "unreachable", attempts: 2, retrying: true })
    expect(decideSaveState({ ...base, meta: meta({ attempts: 5, last_error: "x" }) })).toMatchObject({ state: "failed", retrying: false })
    expect(decideSaveState({ ...base, meta: meta({ attempts: 5, last_error: "x" }), job: "pending" })).toMatchObject({ retrying: true })
  })
  it("a running save wins over an old failure", () => {
    expect(decideSaveState({ ...base, meta: meta({ attempts: 3, last_error: "x" }), job: "processing" }).state).toBe("saving")
  })
  it("a saved copy stays saved even if an old failure is still in the record", () => {
    expect(decideSaveState({ ...base, archivedAt: "2026-11-07T10:00:00Z", meta: meta({ attempts: 3, last_error: "x", filed_in: "storage" }) }).state).toBe("saved")
  })
})

describe("earlier copies", () => {
  const v = (versionNo: number, current = false) => ({ id: `v${versionNo}`, versionNo, createdAt: `2026-11-0${versionNo}T10:00:00Z`, current })
  it("no card when the file has only its current version", () => {
    expect(earlierCopiesToDecide([v(1, true)], null)).toEqual([])
  })
  it("the card lists the earlier versions, oldest first", () => {
    expect(earlierCopiesToDecide([v(3, true), v(2), v(1)], null).map((x) => x.versionNo)).toEqual([1, 2])
  })
  it("a choice silences the card for those copies; a LATER copy brings it back — for just that copy", () => {
    const choice = { choice: "hidden" as const, covered: 1, at: "x", by: "Luca" }
    expect(earlierCopiesToDecide([v(2, true), v(1)], choice)).toEqual([])
    expect(earlierCopiesToDecide([v(3, true), v(2), v(1)], choice).map((x) => x.versionNo)).toEqual([2])
  })
  it("names an earlier copy next to the approved file", () => {
    expect(earlierCopyName("Tax_Data_Acme_LLC.pdf", 1)).toBe("Tax_Data_Acme_LLC (version 1).pdf")
    expect(earlierCopyName("noext", 2)).toBe("noext (version 2)")
  })
})

describe("approvedBy", () => {
  it("the newest entry that released the submission, with the person's name", () => {
    const h = [
      { to: "submitted", at: "2026-11-01T00:00:00Z", by: "client:1" },
      { to: "confirmed", at: "2026-11-05T00:00:00Z", by: "Luca" },
    ]
    expect(approvedBy(h)).toEqual({ at: "2026-11-05T00:00:00Z", by: "Luca" })
  })
  it("the old marker is not a name", () => {
    expect(approvedBy([{ to: "confirmed", at: "2026-11-05T00:00:00Z", by: "flow-action" }])).toEqual({ at: "2026-11-05T00:00:00Z", by: "" })
  })
  it("no approval in the history, or a damaged history", () => {
    expect(approvedBy([{ to: "submitted", at: "x" }])).toBeNull()
    expect(approvedBy(null)).toBeNull()
    expect(approvedBy("x")).toBeNull()
  })
})
