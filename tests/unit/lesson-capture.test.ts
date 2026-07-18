/**
 * Business Brain P2 — shared lesson-capture helper (dev job 203cda1a).
 * Verifies the D1 guarantees WITHOUT a live model/DB via injected deps:
 *  - client scope REQUIRED (no clientKey => suppressed, never a global write)
 *  - inputs narrowed to staff message + prior reply (Adam-Marra fence)
 *  - reasoning (the WHY) is captured and passed through
 *  - substance / prior-reply guards
 */

import { describe, it, expect, vi } from "vitest"
import { captureLessonFromTurn, extractLesson, generalizeForGlobal, distillMarkedMessage, decisionsConflict } from "@/lib/ai-agent/lesson-capture"

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

describe("distillMarkedMessage — 🧠 => global client-free lesson", () => {
  it("returns the general rule distilled from a marked message", async () => {
    const got = await distillMarkedMessage("For Acme LLC always CC their accountant", fakeCall(SCRUBBED))
    expect(got).not.toBeNull()
    expect(got!.situation).toBeTruthy()
    expect(got!.decision).toBe("Say 2-3 weeks after documents are in")
  })

  it("returns null on empty input without calling the model", async () => {
    const call = fakeCall(SCRUBBED)
    expect(await distillMarkedMessage("   ", call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })

  it("returns null when nothing general survives (empty), or on parse/throw", async () => {
    expect(await distillMarkedMessage("x", fakeCall({ empty: true }))).toBeNull()
    expect(await distillMarkedMessage("x", fakeCall("junk" as any))).toBeNull()
    const boom = vi.fn().mockRejectedValue(new Error("down"))
    expect(await distillMarkedMessage("x", boom)).toBeNull()
  })
})

describe("captureLessonFromTurn — D1 guards", () => {
  const baseSave = () => vi.fn().mockResolvedValue("mem-id-1")
  // No existing lesson matches → the correction path falls through to a plain
  // append. Injected so these tests never touch the real embedding API.
  const noMatch = () => vi.fn().mockResolvedValue([])

  it("saves GLOBAL but SCRUBBED when there is no client scope (Antonio: keep auto-saving globally)", async () => {
    const saveFn = baseSave()
    // extract → GOOD_LESSON, then scrub → SCRUBBED (client-free)
    const callFn = sequencedCall(GOOD_LESSON, SCRUBBED)
    const res = await captureLessonFromTurn(
      { staffMessage: "no, tell them 2-3 weeks not 6", priorReply: "6 weeks", clientKey: null, surface: "slack" },
      { callFn, saveFn, recallGlobalFn: noMatch() },
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
      { callFn: fakeCall(GOOD_LESSON), saveFn, recallClientFn: noMatch() },
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
      { callFn: fakeCall(GOOD_LESSON), saveFn, recallClientFn: noMatch() },
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

describe("decisionsConflict", () => {
  it("ignores casing/whitespace differences (a re-statement is not a conflict)", () => {
    expect(decisionsConflict("Bill in USD", "  bill   in usd ")).toBe(false)
  })
  it("flags a genuinely different answer", () => {
    expect(decisionsConflict("Bill in USD", "Bill in EUR")).toBe(true)
  })
})

describe("captureLessonFromTurn — correction = truth (P4 supersede)", () => {
  const GOOD = () => vi.fn().mockResolvedValue({ text: JSON.stringify(GOOD_LESSON) })

  it("SUPERSEDES the nearest same-CLIENT lesson when the decision differs", async () => {
    const saveFn = vi.fn().mockResolvedValue("appended")
    const recallClientFn = vi.fn().mockResolvedValue([{ id: "old-1", decision: "It takes 6 weeks", situation: "s", similarity: 0.97 }])
    const contradictFn = vi.fn().mockResolvedValue("replacement-1")
    const res = await captureLessonFromTurn(
      { staffMessage: "no, tell them 2-3 weeks not 6", priorReply: "6 weeks", clientKey: "account:abc", surface: "portal_chat", mode: "correction" },
      { callFn: GOOD(), saveFn, recallClientFn, contradictFn, recallGlobalFn: vi.fn() },
    )
    expect(res.superseded).toBe("old-1")
    expect(res.memoryId).toBe("replacement-1")
    expect(res.scope).toBe("client")
    // carried the fresh situation + reasoning into the replacement
    expect(contradictFn).toHaveBeenCalledWith(
      "old-1",
      expect.stringContaining("2-3 weeks"),
      expect.objectContaining({ newSituation: expect.any(String), newReasoning: expect.stringContaining("turnaround") }),
    )
    expect(saveFn).not.toHaveBeenCalled() // superseded, not appended
  })

  it("uses the CLIENT scope search for a client capture (never the global one)", async () => {
    const recallClientFn = vi.fn().mockResolvedValue([])
    const recallGlobalFn = vi.fn().mockResolvedValue([{ id: "g", decision: "different", situation: "s", similarity: 0.99 }])
    const saveFn = vi.fn().mockResolvedValue("appended")
    await captureLessonFromTurn(
      { staffMessage: "no, do it the other way please", priorReply: "the first way", clientKey: "account:abc", surface: "portal_chat", mode: "correction" },
      { callFn: GOOD(), saveFn, recallClientFn, recallGlobalFn },
    )
    expect(recallClientFn).toHaveBeenCalled()
    expect(recallGlobalFn).not.toHaveBeenCalled() // scope isolation — no cross-scope supersede
  })

  it("APPENDS (no supersede) when the nearest lesson's decision is the SAME", async () => {
    const saveFn = vi.fn().mockResolvedValue("appended")
    // nearest match's decision equals the extracted lesson → a re-statement, not a correction
    const recallClientFn = vi.fn().mockResolvedValue([{ id: "old-1", decision: GOOD_LESSON.lesson, situation: "s", similarity: 0.99 }])
    const contradictFn = vi.fn()
    const res = await captureLessonFromTurn(
      { staffMessage: "no, tell them 2-3 weeks not 6", priorReply: "6 weeks", clientKey: "account:abc", surface: "portal_chat", mode: "correction" },
      { callFn: GOOD(), saveFn, recallClientFn, contradictFn, recallGlobalFn: vi.fn() },
    )
    expect(contradictFn).not.toHaveBeenCalled()
    expect(res.superseded).toBeUndefined()
    expect(saveFn).toHaveBeenCalled()
  })

  it("APPENDS when there is no near-enough match", async () => {
    const saveFn = vi.fn().mockResolvedValue("appended")
    const contradictFn = vi.fn()
    const res = await captureLessonFromTurn(
      { staffMessage: "no, tell them 2-3 weeks not 6", priorReply: "6 weeks", clientKey: "account:abc", surface: "portal_chat", mode: "correction" },
      { callFn: GOOD(), saveFn, recallClientFn: vi.fn().mockResolvedValue([]), contradictFn, recallGlobalFn: vi.fn() },
    )
    expect(contradictFn).not.toHaveBeenCalled()
    expect(res.memoryId).toBe("appended")
  })

  it("ADDITIVE saves NEVER supersede (and never even search)", async () => {
    const saveFn = vi.fn().mockResolvedValue("appended")
    const recallClientFn = vi.fn()
    const contradictFn = vi.fn()
    await captureLessonFromTurn(
      { staffMessage: "save this rule for this client please", priorReply: "noted", clientKey: "account:abc", surface: "portal_chat", mode: "additive" },
      { callFn: GOOD(), saveFn, recallClientFn, contradictFn, recallGlobalFn: vi.fn() },
    )
    expect(recallClientFn).not.toHaveBeenCalled()
    expect(contradictFn).not.toHaveBeenCalled()
    expect(saveFn).toHaveBeenCalled()
  })

  it("degrades to a plain append if the supersede path throws", async () => {
    const saveFn = vi.fn().mockResolvedValue("appended")
    const recallClientFn = vi.fn().mockResolvedValue([{ id: "old-1", decision: "different", situation: "s", similarity: 0.99 }])
    const contradictFn = vi.fn().mockRejectedValue(new Error("supersede boom"))
    const res = await captureLessonFromTurn(
      { staffMessage: "no, tell them 2-3 weeks not 6", priorReply: "6 weeks", clientKey: "account:abc", surface: "portal_chat", mode: "correction" },
      { callFn: GOOD(), saveFn, recallClientFn, contradictFn, recallGlobalFn: vi.fn() },
    )
    expect(res.saved).toBe(true)
    expect(res.memoryId).toBe("appended")
    expect(res.superseded).toBeUndefined()
  })
})
