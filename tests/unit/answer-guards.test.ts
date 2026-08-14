/**
 * Answer guards (dev job a6c3d75b) — the floor under two prompt rules that failed
 * four times. Fixtures are the VERBATIM replies from the AI Venture Labs incident
 * (2026-07-18) and Antonio's verbatim correction, so this test goes red if someone
 * weakens the detector. Same discipline as the language guard's incident fixtures.
 */

import { describe, it, expect } from "vitest"
import {
  assertsAbsence,
  isCorrection,
  hasSearchedForAbsence,
  buildAbsenceNudge,
  buildCorrectionNudge,
  ABSENCE_EVIDENCE_TOOLS,
  looksLikeFailedLookup,
  assertsCannotDo,
  looksLikeIncompleteRead,
  finalizeReplyForStopReason,
  TRUNCATED_REPLY_NOTE,
  TRUNCATED_EMPTY_REPLY,
  looksLikeDigInAsk,
  QUICK_GEAR_TOOL_CEILING,
  buildQuickGearWrapUpNudge,
  shouldNudgeQuickGear,
} from "@/lib/ai-agent/answer-guards"
import { buildCoverage, coverageNote } from "@/lib/docai-windows"

// ── The real incident, word for word ────────────────────────────────────────
const INCIDENT_REPLY_1 =
  "There's no specific timestamp for when it was physically faxed/submitted to the IRS — only that it was signed on July 2. " +
  "As for the fax history, there's no dedicated fax table in the database. The fax sent date isn't stored here. " +
  "You'll need to check it in whatever fax service you use (e.g. eFax, Notifii, or however IRS faxes are sent) to get the exact sent date."

const INCIDENT_REPLY_2 =
  "No fax table exists in the database at all. The fax history you're referring to in the CRM under Tools → Fax is likely " +
  "a front-end feature that calls an external fax service (like eFax or Notifii) — it's not stored in our database. " +
  "You'll need to check it manually."

const ANTONIO_CORRECTION =
  "I don't think the SS4 has been signed by Gaia plus you have to check the sent date in fax history"

describe("assertsAbsence — catches the real incident", () => {
  it("flags both verbatim incident replies", () => {
    expect(assertsAbsence(INCIDENT_REPLY_1)).toBe(true)
    expect(assertsAbsence(INCIDENT_REPLY_2)).toBe(true)
  })

  it("flags the common shapes of claiming something isn't there", () => {
    for (const s of [
      "That isn't stored in the database.",
      "There is no record of that fax.",
      "That table doesn't exist.",
      "It's not in our system.",
      "I don't have access to the fax history.",
      "You'll need to check it manually.",
      "I couldn't find any record of it.",
    ]) {
      expect(assertsAbsence(s), s).toBe(true)
    }
  })

  it("does NOT flag ordinary answers", () => {
    for (const s of [
      "The SS-4 was faxed to the IRS on July 3 — receipt 1102497100 is filed under the company.",
      "Here's the draft reply for Michele in Italian.",
      "Signed on July 2 by Michele Cotti. Want me to draft a status update?",
      "I've saved that to memory.",
      "",
      "   ",
    ]) {
      expect(assertsAbsence(s), s).toBe(false)
    }
  })
})

describe("the real gate is the tool trace, not the wording", () => {
  it("a reply with NO lookups behind it has no evidence", () => {
    expect(hasSearchedForAbsence([])).toBe(false)
    // the incident: it only ever ran non-search tools
    expect(hasSearchedForAbsence(["memory_recall"])).toBe(false)
  })

  it("any real lookup counts as evidence — a grounded negative passes", () => {
    expect(hasSearchedForAbsence(["run_sql_query"])).toBe(true)
    expect(hasSearchedForAbsence(["drive_search"])).toBe(true)
    expect(hasSearchedForAbsence(["get_client_paperwork"])).toBe(true)
    expect(hasSearchedForAbsence(["memory_recall", "doc_search"])).toBe(true)
  })

  it("covers the two places the incident answer actually lived", () => {
    // documents + a direct query are both reachable and both count
    expect(ABSENCE_EVIDENCE_TOOLS.has("run_sql_query")).toBe(true)
    expect(ABSENCE_EVIDENCE_TOOLS.has("doc_search")).toBe(true)
    expect(ABSENCE_EVIDENCE_TOOLS.has("drive_search")).toBe(true)
  })

  it("the guard only fires on absence-claim AND no-evidence (the honest combination)", () => {
    const fires = (reply: string, tools: string[]) => assertsAbsence(reply) && !hasSearchedForAbsence(tools)
    // the incident — fires
    expect(fires(INCIDENT_REPLY_1, [])).toBe(true)
    // same words, but it actually searched — does NOT fire
    expect(fires(INCIDENT_REPLY_1, ["run_sql_query", "doc_search"])).toBe(false)
    // ordinary answer, no search — does NOT fire
    expect(fires("Faxed July 3, receipt on file.", [])).toBe(false)
  })
})

describe("isCorrection — catches Antonio pushing back", () => {
  it("flags his verbatim correction", () => {
    expect(isCorrection(ANTONIO_CORRECTION)).toBe(true)
  })

  it("flags the common push-back shapes", () => {
    for (const s of [
      "I don't think that's right",
      "Are you sure?",
      "that's wrong",
      "no, it was Michele",
      "check again",
      "you're wrong",
      "you have to check the fax history",
    ]) {
      expect(isCorrection(s), s).toBe(true)
    }
  })

  it("does NOT flag ordinary instructions", () => {
    for (const s of [
      "draft it",
      "send it",
      "summarize this client",
      "when was the SS-4 faxed?",
      "",
    ]) {
      expect(isCorrection(s), s).toBe(false)
    }
  })
})

describe("nudges", () => {
  it("name the places that were missed in the incident", () => {
    const n = buildAbsenceNudge()
    expect(n.toLowerCase()).toContain("documents")
    expect(n.toLowerCase()).toContain("activity log")
    expect(n.toLowerCase()).toContain("drive")
    expect(n).toContain("STOP")
  })

  it("the correction nudge demands a fresh, different source", () => {
    const n = buildCorrectionNudge()
    expect(n.toLowerCase()).toContain("fresh")
    expect(n.toLowerCase()).toContain("different")
    expect(n.toLowerCase()).toContain("assume you are wrong")
  })
})

describe("a FAILED lookup is not evidence — the incident's real mechanism", () => {
  it("recognises the errors the worker actually hit (invented table names)", () => {
    // Verbatim shape of what Postgres returns for the tables it guessed at 15:33/15:34
    for (const r of [
      'ERROR: relation "fax_history" does not exist',
      'ERROR: relation "ss4_fax_history" does not exist',
      '❌ SQL Error: syntax error at or near ";"',
      '{"error":"permission denied for table documents"}',
      '{"lookup_failed":true,"error":"query failed"}',
      'undefined_table',
    ]) {
      expect(looksLikeFailedLookup(r), r).toBe(true)
    }
  })

  it("does NOT mistake a real answer for a failure", () => {
    for (const r of [
      '{"count":3,"documents":[{"file_name":"fax-receipt-1102497100.pdf"}]}',
      '{"entries":[{"what":"fax_sent","summary":"Fax sent to 8556416935"}]}',
      '[]',
      '{"count":0,"documents":[]}', // a genuine empty result is NOT a failure
    ]) {
      expect(looksLikeFailedLookup(r), r).toBe(false)
    }
  })

  it("THE INCIDENT: queries ran, both errored → still counts as not-searched", () => {
    // What actually happened: run_sql_query twice, both against tables that don't exist.
    const attempted = ["run_sql_query", "run_sql_query"]
    const succeeded: string[] = [] // both errored, so nothing succeeded
    // The naive check would have passed it through — that's the trap.
    expect(hasSearchedForAbsence(attempted)).toBe(true)
    // The real check correctly says: no evidence.
    expect(hasSearchedForAbsence(succeeded)).toBe(false)
    expect(assertsAbsence(INCIDENT_REPLY_2) && !hasSearchedForAbsence(succeeded)).toBe(true)
  })

  it("a query that SUCCEEDS is evidence, and the guard stands down", () => {
    const succeeded = ["run_sql_query", "search_documents"]
    expect(assertsAbsence(INCIDENT_REPLY_2) && !hasSearchedForAbsence(succeeded)).toBe(false)
  })
})

describe("reading a scanned document counts as looking", () => {
  it("OCR is evidence — the signed-form case that stumped it", () => {
    expect(hasSearchedForAbsence(["read_scanned_document"])).toBe(true)
    // "I can't tell who signed" + it never opened the document = still unfounded
    expect(assertsAbsence("I don't have access to the signed document.") && !hasSearchedForAbsence([])).toBe(true)
    // but once it has actually read the file, the claim is grounded
    expect(assertsAbsence("I don't have access to the signed document.") && !hasSearchedForAbsence(["read_scanned_document"])).toBe(false)
  })
})

describe("assertsCannotDo — capability gaps that need CODE, not a correction", () => {
  it("flags Antonio's real Slack-link refusal", () => {
    expect(assertsCannotDo(
      "I can't access external URLs or Slack links directly — I don't have a browser or Slack API access. " +
      "Could you paste the message content here? I'll read it and help right away."
    )).toBe(true)
  })

  it("flags other capability refusals", () => {
    for (const s of [
      "I don't have access to the fax service.",
      "I'm unable to open that file.",
      "I don't have the ability to send faxes.",
      "That's not something I can do.",
    ]) {
      expect(assertsCannotDo(s), s).toBe(true)
    }
  })

  it("does NOT flag business statements or ordinary answers", () => {
    for (const s of [
      "The client can't sign until the OA is countersigned.",
      "We can't file before the EIN arrives.",
      "Faxed July 3 — receipt on file.",
      "",
    ]) {
      expect(assertsCannotDo(s), s).toBe(false)
    }
  })
})

// ── Partial document reads must not count as "it looked" ────────────────────
// A 35-page scanned tax return is read a 15-page window at a time. That read
// SUCCEEDS — no error, no lookup_failed — so without an explicit check the
// absence guard is satisfied by 43% of the document and the worker can say
// "there is no Schedule C in this return" when Schedule C is on page 22.
describe("looksLikeIncompleteRead — partial reads are not proof of search", () => {
  it("flags the real coverage payload of a first-window read", () => {
    const payload = JSON.stringify({
      file_name: "2023 Return.pdf",
      coverage: buildCoverage(35, [1, 15]),
      text: "Form 1065 ...",
    })
    expect(looksLikeIncompleteRead(payload)).toBe(true)
  })

  it("does NOT flag a complete read", () => {
    const payload = JSON.stringify({
      file_name: "EIN Letter.pdf",
      coverage: buildCoverage(2, [1, 2]),
      text: "CP 575 ...",
    })
    expect(looksLikeIncompleteRead(payload)).toBe(false)
  })

  it("flags the prose note too, as a belt-and-braces second signal", () => {
    expect(looksLikeIncompleteRead(coverageNote(buildCoverage(35, [1, 15])))).toBe(true)
  })

  it("a partial read is NOT also misread as a failed lookup", () => {
    // It must be excluded as INCOMPLETE, not as an error — a coverage record
    // carrying an error-shaped key would disarm the failed-lookup guard for
    // genuinely successful reads.
    const payload = JSON.stringify({ coverage: buildCoverage(35, [1, 15]), text: "..." })
    expect(looksLikeFailedLookup(payload)).toBe(false)
    expect(looksLikeIncompleteRead(payload)).toBe(true)
  })

  it("ignores empty/garbage input", () => {
    expect(looksLikeIncompleteRead("")).toBe(false)
    expect(looksLikeIncompleteRead(null)).toBe(false)
    expect(looksLikeIncompleteRead(undefined)).toBe(false)
  })

  it("only inspects the head, so 'complete: false' deep in client text is ignored", () => {
    const payload = `${JSON.stringify({ coverage: buildCoverage(3, [1, 3]) })}${" ".repeat(700)}"complete": false`
    expect(looksLikeIncompleteRead(payload)).toBe(false)
  })

  it("THE SCENARIO: a partial read alone must not satisfy the absence guard", () => {
    const partial = JSON.stringify({ coverage: buildCoverage(35, [1, 15]), text: "..." })
    // Simulates the loop's rule at the single choke point in worker-tools.
    const counts = !looksLikeFailedLookup(partial) && !looksLikeIncompleteRead(partial)
    expect(counts).toBe(false)
    expect(hasSearchedForAbsence(counts ? ["read_scanned_document"] : [])).toBe(false)
  })

  it("a COMPLETE read of the same tool still satisfies the guard", () => {
    const full = JSON.stringify({ coverage: buildCoverage(9, [1, 9]), text: "..." })
    const counts = !looksLikeFailedLookup(full) && !looksLikeIncompleteRead(full)
    expect(counts).toBe(true)
    expect(hasSearchedForAbsence(["read_scanned_document"])).toBe(true)
  })
})

// ── Truncated answers (added with the Claude-5 models) ───────────────────────
// These exist because the newer models reason before answering and that reasoning
// is charged against the SAME output ceiling, so they hit it far sooner. Before
// this, a cut-off answer shipped looking complete and an empty one became the
// meaningless "(no response generated)".
describe("finalizeReplyForStopReason", () => {
  it("leaves a normally-finished answer completely untouched", () => {
    const reply = "Lepren LLC has two open invoices."
    expect(finalizeReplyForStopReason(reply, "end_turn")).toBe(reply)
    expect(finalizeReplyForStopReason(reply, "tool_use")).toBe(reply)
    expect(finalizeReplyForStopReason(reply, undefined)).toBe(reply)
  })

  it("marks an answer that was cut off, keeping the text that was written", () => {
    const out = finalizeReplyForStopReason("The total for March is 4,21", "max_tokens")
    expect(out).toContain("The total for March is 4,21")
    expect(out).toContain(TRUNCATED_REPLY_NOTE)
  })

  it("replaces an EMPTY truncated answer rather than returning a blank reply", () => {
    expect(finalizeReplyForStopReason("", "max_tokens")).toBe(TRUNCATED_EMPTY_REPLY)
    expect(finalizeReplyForStopReason("   \n ", "max_tokens")).toBe(TRUNCATED_EMPTY_REPLY)
  })

  it("never silently drops the fact that an answer was incomplete", () => {
    // The whole point: a truncated reply must never be indistinguishable from a
    // finished one. Whatever the text, the marker has to be present.
    for (const text of ["short", "a".repeat(5000), "ends mid-sent"]) {
      expect(finalizeReplyForStopReason(text, "max_tokens")).not.toBe(text)
    }
  })
})

// ── Quick-gear ceiling (dev job 5e87b099, 2026-08-14) ───────────────────────
// Luca, Team Chat, Aumianna LLC/Smit Shah: asked for a plain "read this email,
// draft a reply, attach the file" and got a 12-tool research spree instead.
describe("looksLikeDigInAsk — the quick-gear ceiling's classifier", () => {
  it("flags explicit investigation requests", () => {
    for (const s of [
      "Can you investigate why this client's invoice is wrong?",
      "Please diagnose the sync issue.",
      "Run a full audit on this account.",
      "Why did this fail?",
      "Can you dig in and figure out what happened here?",
      "Look into this for me.",
    ]) {
      expect(looksLikeDigInAsk(s), s).toBe(true)
    }
  })

  it("does NOT flag Luca's actual verbatim requests (Aumianna LLC, 2026-08-13)", () => {
    expect(looksLikeDigInAsk("Read the email.")).toBe(false)
    expect(looksLikeDigInAsk("I only wanted the email prepared and the file attached.")).toBe(false)
  })

  it("does NOT flag ordinary mechanical asks", () => {
    for (const s of [
      "Draft a reply and attach the file.",
      "Create a draft like this one for this company.",
      "Send it.",
      "Attach the signed copy.",
      "",
    ]) {
      expect(looksLikeDigInAsk(s), s).toBe(false)
    }
  })

  it("deliberately does not treat bare 'check' as dig-in — the prompt itself uses that word for both gears", () => {
    expect(looksLikeDigInAsk("Check this email and draft a reply.")).toBe(false)
  })
})

describe("the quick-gear ceiling", () => {
  it("the nudge is a check-in, not a hard stop — it tells the model to answer OR justify continuing", () => {
    const n = buildQuickGearWrapUpNudge()
    expect(n.toLowerCase()).toContain("stop here and answer")
    expect(n.toLowerCase()).toContain("plain")
    // must not simply command it to stop — genuine continued digging stays legitimate
    expect(n.toLowerCase()).toContain("then continue")
  })

  it("is calibrated above the two legitimately-scoped comparison incidents (5 and 7 tool calls)", () => {
    // Giulio Sembinelli Trainer LLC and Rise Profit LLC (2026-08-12) both stayed
    // narrowly scoped at 5 and 7 tool calls for a materially similar template
    // task — the ceiling must not clip either of them.
    expect(QUICK_GEAR_TOOL_CEILING).toBeGreaterThan(7)
  })

  it("is well below the incident that prompted it (12 tool calls)", () => {
    expect(QUICK_GEAR_TOOL_CEILING).toBeLessThan(12)
  })
})

describe("shouldNudgeQuickGear — the exact gate wired into the loop", () => {
  const base = { alreadyLatched: false, staffLooksLikeDigIn: false, pendingReadsCount: 0, toolCallCount: 9 }

  it("fires for a plain ask past the ceiling with no reads in flight", () => {
    expect(shouldNudgeQuickGear(base)).toBe(true)
  })

  it("does NOT fire below the ceiling", () => {
    expect(shouldNudgeQuickGear({ ...base, toolCallCount: QUICK_GEAR_TOOL_CEILING - 1 })).toBe(false)
  })

  it("fires AT exactly the ceiling — the boundary bug-hunter found untested (>= vs >)", () => {
    expect(shouldNudgeQuickGear({ ...base, toolCallCount: QUICK_GEAR_TOOL_CEILING })).toBe(true)
  })

  it("does NOT fire once already latched — one nudge only", () => {
    expect(shouldNudgeQuickGear({ ...base, alreadyLatched: true })).toBe(false)
  })

  it("does NOT fire when the staff member's own message reads as dig-in", () => {
    expect(shouldNudgeQuickGear({ ...base, staffLooksLikeDigIn: true })).toBe(false)
  })

  it("bug-hunter finding (2026-08-14): does NOT fire while a windowed read is genuinely mid-flight, even past the ceiling — the read-to-the-end guard already owns that turn", () => {
    expect(shouldNudgeQuickGear({ ...base, pendingReadsCount: 1 })).toBe(false)
    expect(shouldNudgeQuickGear({ ...base, pendingReadsCount: 1, toolCallCount: 20 })).toBe(false)
  })

  it("fires again once the read finishes and the ceiling is still crossed with a fresh (unlatched) turn", () => {
    expect(shouldNudgeQuickGear({ ...base, pendingReadsCount: 0 })).toBe(true)
  })
})
