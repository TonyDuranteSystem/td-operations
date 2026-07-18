/**
 * Business Brain P2 — shared lesson-capture helper (dev job 203cda1a).
 * Verifies the D1 guarantees WITHOUT a live model/DB via injected deps:
 *  - client scope REQUIRED (no clientKey => suppressed, never a global write)
 *  - inputs narrowed to staff message + prior reply (Adam-Marra fence)
 *  - reasoning (the WHY) is captured and passed through
 *  - substance / prior-reply guards
 */

import { describe, it, expect, vi } from "vitest"
import { captureLessonFromTurn, extractLesson, generalizeForGlobal } from "@/lib/ai-agent/lesson-capture"

/** A callAI stub returning a fixed JSON payload for every call. */
function fakeCall(payload: unknown): any {
  return vi.fn().mockResolvedValue({ text: JSON.stringify(payload) })
}

/** A callAI stub returning a different payload per successive call (extract, then scrub). */
function sequencedCall(...payloads: unknown[]): any {
  const fn = vi.fn()
  for (const p of payloads) fn.mockResolvedValueOnce({ text: JSON.stringify(p) })
  return fn
}

const GOOD_LESSON = {
  situation: "Client asks how long formation takes",
  lesson: "Tell them 2-3 weeks after documents are in",
  reasoning: "That is our real turnaround once the state filing is submitted",
  domain: "formation",
}

/** What generalizeForGlobal emits — note `decision` (not `lesson`) + client-free. */
const SCRUBBED = {
  situation: "A client asks how long formation takes",
  decision: "Say 2-3 weeks after documents are in",
  reasoning: "Standard turnaround once the state filing is submitted",
}

describe("extractLesson", () => {
  it("parses a well-formed lesson including reasoning", async () => {
    const got = await extractLesson("prior reply", "staff correction here", fakeCall(GOOD_LESSON))
    expect(got).not.toBeNull()
    expect(got!.lesson).toContain("2-3 weeks")
    expect(got!.reasoning).toContain("turnaround")
  })

  it("tolerates code-fenced JSON", async () => {
    const call = vi.fn().mockResolvedValue({ text: "```json\n" + JSON.stringify(GOOD_LESSON) + "\n```" })
    const got = await extractLesson("prior", "staff message", call)
    expect(got!.domain).toBe("formation")
  })

  it("returns null on no_lesson", async () => {
    expect(await extractLesson("prior", "staff message", fakeCall({ no_lesson: true }))).toBeNull()
  })

  it("returns null when situation or lesson is missing", async () => {
    expect(await extractLesson("prior", "staff message", fakeCall({ lesson: "x" }))).toBeNull()
    expect(await extractLesson("prior", "staff message", fakeCall({ situation: "x" }))).toBeNull()
  })

  it("returns null on unparseable model output (best-effort, never throws)", async () => {
    const call = vi.fn().mockResolvedValue({ text: "sorry I cannot help" })
    expect(await extractLesson("prior", "staff message", call)).toBeNull()
  })

  it("returns null when the extractor throws", async () => {
    const call = vi.fn().mockRejectedValue(new Error("model down"))
    expect(await extractLesson("prior", "staff message", call)).toBeNull()
  })
})

describe("generalizeForGlobal — scrub before any global write", () => {
  it("returns the client-free rewrite", async () => {
    const got = await generalizeForGlobal(
      { situation: "Acme LLC asked about timing", decision: "Told Acme 2-3 weeks", reasoning: "state filing" },
      fakeCall(SCRUBBED),
    )
    expect(got).not.toBeNull()
    expect(got!.decision).toBe("Say 2-3 weeks after documents are in")
  })

  it("returns null when nothing reusable survives the scrub (empty)", async () => {
    expect(
      await generalizeForGlobal({ situation: "s", decision: "d" }, fakeCall({ empty: true })),
    ).toBeNull()
  })

  it("returns null on unparseable output or throw (fail closed)", async () => {
    expect(await generalizeForGlobal({ situation: "s", decision: "d" }, fakeCall("nope" as any))).toBeNull()
    const boom = vi.fn().mockRejectedValue(new Error("down"))
    expect(await generalizeForGlobal({ situation: "s", decision: "d" }, boom)).toBeNull()
  })
})

describe("captureLessonFromTurn — D1 guards", () => {
  const baseSave = () => vi.fn().mockResolvedValue("mem-id-1")

  it("saves GLOBAL but SCRUBBED when there is no client scope (Antonio: keep auto-saving globally)", async () => {
    const saveFn = baseSave()
    // extract → GOOD_LESSON, then scrub → SCRUBBED (client-free)
    const callFn = sequencedCall(GOOD_LESSON, SCRUBBED)
    const res = await captureLessonFromTurn(
      { staffMessage: "no, tell them 2-3 weeks not 6", priorReply: "6 weeks", clientKey: null, surface: "slack" },
      { callFn, saveFn },
    )
    expect(res.saved).toBe(true)
    expect(res.scope).toBe("global")
    const arg = saveFn.mock.calls[0][0]
    expect(arg.clientKey).toBeNull()
    // the SCRUBBED text was written, not the raw extracted lesson
    expect(arg.decision).toBe("Say 2-3 weeks after documents are in")
    expect(callFn).toHaveBeenCalledTimes(2) // extract + scrub
  })

  it("FAILS CLOSED: a global write whose scrub yields nothing reusable is skipped", async () => {
    const saveFn = baseSave()
    const callFn = sequencedCall(GOOD_LESSON, { empty: true })
    const res = await captureLessonFromTurn(
      { staffMessage: "just a general aside with a client name in it", priorReply: "prior", clientKey: null, surface: "team_chat" },
      { callFn, saveFn },
    )
    expect(res.saved).toBe(false)
    expect(res.skipReason).toBe("scrub_empty")
    expect(saveFn).not.toHaveBeenCalled()
  })

  it("saves CLIENT-SCOPED with reasoning when a clientKey is present", async () => {
    const saveFn = baseSave()
    const res = await captureLessonFromTurn(
      {
        staffMessage: "no, tell them 2-3 weeks not 6",
        priorReply: "It takes about 6 weeks",
        clientKey: "account:abc",
        surface: "portal_chat",
        sourceRef: "portal:msg-9",
      },
      { callFn: fakeCall(GOOD_LESSON), saveFn },
    )
    expect(res.saved).toBe(true)
    expect(res.memoryId).toBe("mem-id-1")
    const arg = saveFn.mock.calls[0][0]
    expect(arg.clientKey).toBe("account:abc")
    expect(arg.reasoning).toContain("turnaround")
    expect(arg.sourceType).toBe("portal_chat")
    expect(arg.botSaid).toContain("6 weeks")
    expect(arg.tags).toContain("auto_correction")
  })

  it("tags additive saves distinctly and marks them confirmed (P4: never supersede)", async () => {
    const saveFn = baseSave()
    await captureLessonFromTurn(
      { staffMessage: "save this: we always chase the wire", priorReply: "ok noted", clientKey: "contact:z", surface: "team_chat", mode: "additive" },
      { callFn: fakeCall(GOOD_LESSON), saveFn },
    )
    const arg = saveFn.mock.calls[0][0]
    expect(arg.tags).toContain("explicit_save")
    expect(arg.correctionType).toBe("confirmed")
  })

  it("suppresses a too-short message before any model/DB call", async () => {
    const saveFn = baseSave()
    const callFn = fakeCall(GOOD_LESSON)
    const res = await captureLessonFromTurn(
      { staffMessage: "no", priorReply: "something", clientKey: "account:abc", surface: "inbox" },
      { callFn, saveFn },
    )
    expect(res.skipReason).toBe("message_too_short")
    expect(callFn).not.toHaveBeenCalled()
    expect(saveFn).not.toHaveBeenCalled()
  })

  it("suppresses when there is no prior worker reply to ground against", async () => {
    const saveFn = baseSave()
    const res = await captureLessonFromTurn(
      { staffMessage: "this is a long enough message to pass", priorReply: "", clientKey: "account:abc", surface: "inbox" },
      { callFn: fakeCall(GOOD_LESSON), saveFn },
    )
    expect(res.skipReason).toBe("no_prior_reply")
    expect(saveFn).not.toHaveBeenCalled()
  })

  it("never throws when the save fails — returns error skipReason", async () => {
    const saveFn = vi.fn().mockRejectedValue(new Error("db down"))
    const res = await captureLessonFromTurn(
      { staffMessage: "no, tell them 2-3 weeks not 6", priorReply: "6 weeks", clientKey: "account:abc", surface: "portal_chat" },
      { callFn: fakeCall(GOOD_LESSON), saveFn },
    )
    expect(res.saved).toBe(false)
    expect(res.skipReason).toBe("error")
  })

  it("returns no_lesson when the extractor finds nothing reusable", async () => {
    const saveFn = baseSave()
    const res = await captureLessonFromTurn(
      { staffMessage: "thanks, that is perfect", priorReply: "here is your answer", clientKey: "account:abc", surface: "portal_chat" },
      { callFn: fakeCall({ no_lesson: true }), saveFn },
    )
    expect(res.skipReason).toBe("no_lesson")
    expect(saveFn).not.toHaveBeenCalled()
  })
})
