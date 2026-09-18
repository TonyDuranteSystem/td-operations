/**
 * Tests for lib/messaging/backfill-matches.ts — classifyGroups.
 *
 * Covers: a single exact-number match is confident, two candidates sharing
 * the same full number are ambiguous (the real Christian P. / Uccio Durante
 * incident, 2026-09-18), a shared-last-8-digits-only pair is NOT a match
 * (different full numbers), and a candidate with no phone or a too-short
 * phone is never a false match.
 */

import { describe, it, expect } from "vitest"
import { classifyGroups, type MatchCandidate, type GroupToMatch } from "@/lib/messaging/backfill-matches"

describe("classifyGroups", () => {
  it("returns exactly one candidate for a confident, unique full-number match", () => {
    const groups: GroupToMatch[] = [{ groupId: "g1", digits: "355698678746" }]
    const candidates: MatchCandidate[] = [
      { type: "contact", id: "c1", name: "Marinela Marku", phone: "+355698678746" },
      { type: "contact", id: "c2", name: "Someone Else", phone: "+15550001111" },
    ]
    const result = classifyGroups(groups, candidates)
    expect(result).toEqual([{ groupId: "g1", candidates: [candidates[0]] }])
  })

  it("returns both candidates when the exact same full number is on two different records", () => {
    // The real incident: Uccio Durante and Christian Pozza shared one number.
    const groups: GroupToMatch[] = [{ groupId: "g1", digits: "393480610794" }]
    const candidates: MatchCandidate[] = [
      { type: "contact", id: "uccio", name: "Uccio Durante", phone: "+39 348 061 0794" },
      { type: "contact", id: "christian", name: "Christian Pozza", phone: "+393480610794" },
    ]
    const result = classifyGroups(groups, candidates)
    expect(result[0].candidates).toHaveLength(2)
    expect(result[0].candidates.map((c) => c.id).sort()).toEqual(["christian", "uccio"])
  })

  it("does NOT match two numbers that only share their last 8 digits", () => {
    const groups: GroupToMatch[] = [{ groupId: "g1", digits: "3969867874" }] // e.g. +39 69 867 8746 minus formatting quirks aside
    const candidates: MatchCandidate[] = [
      { type: "contact", id: "c1", name: "Different Country", phone: "+355698678746" },
    ]
    const result = classifyGroups(groups, candidates)
    expect(result[0].candidates).toHaveLength(0)
  })

  it("ignores a candidate with no phone or a too-short phone", () => {
    const groups: GroupToMatch[] = [{ groupId: "g1", digits: "17274521093" }]
    const candidates: MatchCandidate[] = [
      { type: "lead", id: "l1", name: "No Phone", phone: null },
      { type: "lead", id: "l2", name: "Too Short", phone: "123" },
    ]
    const result = classifyGroups(groups, candidates)
    expect(result[0].candidates).toHaveLength(0)
  })

  it("returns an empty candidate list for a group with no match", () => {
    const groups: GroupToMatch[] = [{ groupId: "g1", digits: "17274521093" }]
    const result = classifyGroups(groups, [])
    expect(result).toEqual([{ groupId: "g1", candidates: [] }])
  })

  it("classifies multiple groups independently in one pass", () => {
    const groups: GroupToMatch[] = [
      { groupId: "g1", digits: "17274521093" },
      { groupId: "g2", digits: "355698678746" },
      { groupId: "g3", digits: "19998887777" },
    ]
    const candidates: MatchCandidate[] = [
      { type: "lead", id: "l1", name: "Match One", phone: "+17274521093" },
      { type: "contact", id: "c1", name: "Match Two", phone: "+355698678746" },
    ]
    const result = classifyGroups(groups, candidates)
    expect(result.find((r) => r.groupId === "g1")?.candidates).toHaveLength(1)
    expect(result.find((r) => r.groupId === "g2")?.candidates).toHaveLength(1)
    expect(result.find((r) => r.groupId === "g3")?.candidates).toHaveLength(0)
  })
})
