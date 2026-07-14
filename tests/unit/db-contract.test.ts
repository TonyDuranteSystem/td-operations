/**
 * The code↔database contract check.
 *
 * These tests are written against the ACTUAL 2026-07-14 incident, not invented shapes: the code
 * wrote `needs_review` into a column whose CHECK constraint did not allow it, every write was
 * rejected, every error was discarded, and the review queue silently did not exist for months.
 * The first test below is that failure, reproduced.
 */

import { describe, it, expect } from "vitest"
import {
  checkDbContract,
  diffAgainstSnapshot,
  parseAllowedValues,
  checksumDefs,
  rowsToDefs,
  CONSTRAINT_CONTRACTS,
} from "@/lib/db-contract"
import { prodConstraints, prodSnapshotMeta, verifySnapshotIntegrity } from "@/lib/db-contract-snapshot"

/** A constraint set that agrees with the code — built FROM the code, so it stays in step. */
function agreeingDefs(): Record<string, string> {
  const defs: Record<string, string> = {}
  for (const c of CONSTRAINT_CONTRACTS) {
    const values = (c.values as readonly string[]).map(v => `'${v}'::text`).join(", ")
    defs[c.constraint] = `CHECK ((${c.column} = ANY (ARRAY[${values}])))`
  }
  return defs
}

describe("parseAllowedValues", () => {
  it("pulls the literals out of an ANY(ARRAY[...]) definition", () => {
    expect(parseAllowedValues("CHECK ((status = ANY (ARRAY['a'::text, 'b'::text])))")).toEqual(["a", "b"])
  })

  it("handles the ::character varying form Postgres prints for varchar columns", () => {
    const def =
      "CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'sent'::character varying])::text[])))"
    expect(parseAllowedValues(def)).toEqual(["draft", "sent"])
  })

  it("returns nothing for a shape rule — it is not a vocabulary", () => {
    expect(parseAllowedValues("CHECK (((account_id IS NOT NULL) OR (contact_id IS NOT NULL)))")).toEqual([])
  })

  it("does not mistake a regex constraint for a value list", () => {
    expect(parseAllowedValues("CHECK ((loc_code ~ '^[A-Z]{2}$'::text))")).toEqual([])
  })
})

describe("checkDbContract", () => {
  it("passes when the code and the database agree", () => {
    const { violations } = checkDbContract(agreeingDefs())
    expect(violations).toEqual([])
  })

  it("THE 2026-07-14 INCIDENT: catches a status the code writes but the database rejects", () => {
    const defs = agreeingDefs()
    // Production's constraint as it actually was: no needs_review, no activation_crashed.
    defs.td_bank_feeds_status_check =
      "CHECK ((status = ANY (ARRAY['unmatched'::text, 'matched'::text, 'ignored'::text, 'duplicate'::text, 'outgoing'::text])))"

    const { violations } = checkDbContract(defs)
    const v = violations.find(x => x.constraint === "td_bank_feeds_status_check")

    expect(v?.kind).toBe("code_writes_rejected_values")
    expect(v?.rejectedValues).toEqual(["needs_review", "activation_crashed"])
  })

  it("treats a MISSING constraint as a failure, not as permission", () => {
    // Sandbox had no constraints at all on this table. That is not "safe" — it is a database
    // more permissive than production, where every test passes and proves nothing.
    const defs = agreeingDefs()
    delete defs.td_bank_feeds_status_check

    const { violations } = checkDbContract(defs)
    expect(violations.find(v => v.constraint === "td_bank_feeds_status_check")?.kind).toBe("constraint_missing")
  })

  it("fails on a NEW constrained column nobody registered", () => {
    const defs = agreeingDefs()
    defs.brand_new_widget_status_check = "CHECK ((status = ANY (ARRAY['on'::text, 'off'::text])))"

    const { violations } = checkDbContract(defs)
    expect(violations.find(v => v.constraint === "brand_new_widget_status_check")?.kind).toBe(
      "constraint_unregistered",
    )
  })

  it("does not flag the known-unaudited baseline or shape rules", () => {
    const defs = agreeingDefs()
    defs.esign_templates_status_check = "CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))" // baseline
    defs.payments_must_have_payer = "CHECK (((account_id IS NOT NULL) OR (contact_id IS NOT NULL)))" // shape rule

    const { violations } = checkDbContract(defs)
    expect(violations).toEqual([])
  })

  it("warns — but does not fail — when the database allows a value the code retired", () => {
    const defs = agreeingDefs()
    defs.td_bank_feeds_source_check = defs.td_bank_feeds_source_check.replace(
      "'chase'::text",
      "'chase'::text, 'ancient_bank'::text",
    )

    const { violations, warnings } = checkDbContract(defs)
    expect(violations).toEqual([])
    expect(warnings[0]?.unusedValues).toEqual(["ancient_bank"])
  })
})

describe("diffAgainstSnapshot", () => {
  const snapshot = { a: "CHECK (x)", b: "CHECK (y)" }

  it("sees nothing when they agree", () => {
    expect(diffAgainstSnapshot({ a: "CHECK (x)", b: "CHECK (y)" }, snapshot)).toEqual([])
  })

  it("catches a constraint changed by hand in the dashboard", () => {
    const drift = diffAgainstSnapshot({ a: "CHECK (x)", b: "CHECK (z)" }, snapshot)
    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ kind: "changed", constraint: "b" })
  })

  it("catches a constraint added live but missing from the snapshot", () => {
    const drift = diffAgainstSnapshot({ a: "CHECK (x)", b: "CHECK (y)", c: "CHECK (n)" }, snapshot)
    expect(drift[0]).toMatchObject({ kind: "added", constraint: "c" })
  })

  it("catches a constraint dropped from the live database", () => {
    const drift = diffAgainstSnapshot({ a: "CHECK (x)" }, snapshot)
    expect(drift[0]).toMatchObject({ kind: "removed", constraint: "b" })
  })
})

describe("checksumDefs", () => {
  it("is order-independent — the map, not the insertion order, is the fact", () => {
    expect(checksumDefs({ a: "1", b: "2" })).toBe(checksumDefs({ b: "2", a: "1" }))
  })

  it("changes when any definition changes", () => {
    expect(checksumDefs({ a: "1" })).not.toBe(checksumDefs({ a: "2" }))
  })

  it("matches the digest PRODUCTION computed over its own constraints", () => {
    // The snapshot was not hand-verified by eye; the database fingerprinted its own rules and
    // we recomputed the same fingerprint over the file. This test pins that agreement, so a
    // future edit of the file cannot quietly diverge from the database it claims to describe.
    expect(checksumDefs(prodConstraints())).toBe("665364ba9d4e7746d9f3fd558dc6ff55")
  })
})

describe("the committed production snapshot", () => {
  it("is internally consistent (checksum and count match its own contents)", () => {
    expect(verifySnapshotIntegrity()).toEqual({ ok: true })
  })

  it("holds production's full constraint set", () => {
    expect(prodSnapshotMeta().count).toBe(190)
    expect(Object.keys(prodConstraints())).toHaveLength(190)
  })

  it("PRODUCTION accepts every value the code can write", () => {
    // The one that matters. If this ever goes red, a write is being rejected in production
    // right now — silently, unless the caller happened to check the error.
    const { violations } = checkDbContract(prodConstraints())
    expect(violations).toEqual([])
  })
})

describe("rowsToDefs", () => {
  it("turns query rows into the map every comparison takes", () => {
    expect(rowsToDefs([{ name: "a", def: "CHECK (x)" }])).toEqual({ a: "CHECK (x)" })
  })
})
