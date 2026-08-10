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
    // Every status the code can write that the old constraint lacked. `owner_ledger` joined
    // the vocabulary on 2026-07-27 and is absent from that historical CHECK too.
    expect(v?.rejectedValues).toEqual(["needs_review", "activation_crashed", "owner_ledger"])
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
    // Re-pinned 2026-07-29 after regenerating the snapshot from PRODUCTION via
    // `npm run snapshot:constraints` (which refuses to run against any other
    // database) — the S-corp books table (td_books_transactions) added two CHECKs
    // (category vocabulary incl. 'transfer', non-blank ref), 200 -> 202. The value
    // below is the digest PRODUCTION computed over its own constraints, not one
    // recomputed to make a red test pass — the previous pin was
    // 3f58eb3fcf707e5cc3751583ee212ac6 over 200 (2026-07-28, 'revolut' source),
    // before that 9c43924c747b933a5336c5bcd57e780a over 200, 4d0d3a38… over 194,
    // and 665364ba9d4e7746d9f3fd558dc6ff55 over 190.
    // Re-pinned again 2026-07-31 (later) after the second e-sign audit migration
    // (20260731-2130) added 'deadline_changed' — staff can now change the deadline of a
    // document already out with a client, and that change is recorded rather than silent.
    // Count unchanged at 203 (a constraint REPLACED, not added). Previous pin
    // 9b7d52e2e9c3f24ab52b77cddefb1398 over 203.
    // Re-pinned 2026-07-31 after Antonio applied the e-sign audit-event migration
    // (20260731-1830) to production by hand: esign_events_type_check gained 'expired'
    // + 'reopened'. Refreshing also picked up ONE unrelated constraint that had been
    // on production since 2026-07-29 and was missing from the file —
    // staff_note_replies_body_check — so 202 -> 203. The value below is the digest
    // PRODUCTION computed over its own constraints (verified: the local recomputation
    // over this file returned the identical string), not one recomputed to make a red
    // test pass — the previous pin was 9c3dfb6d1288e2c73de950a38dd2ba93 over 202
    // (2026-07-29, S-corp books), before that 3f58eb3fcf707e5cc3751583ee212ac6 over
    // 200 (2026-07-28, 'revolut' source), 9c43924c747b933a5336c5bcd57e780a over 200,
    // 4d0d3a38… over 194, and 665364ba9d4e7746d9f3fd558dc6ff55 over 190.
    // Re-pinned 2026-07-31 (later the same day) with the portal-send migration: Antonio
    // applied it to production by hand, adding worker_prepared_sends_kind_check,
    // _draft_locale_check and _kind_shape — 203 -> 206.
    //
    // THE VALUE BELOW IS PRODUCTION'S OWN DIGEST, obtained by making PRODUCTION compute
    // it (md5 over `name|def` newline-joined, name-ordered — the same payload
    // checksumDefs builds), NOT by recomputing over this file until the test went green.
    // The two were NOT identical at first, which is the whole point of pinning it.
    //
    // A NOTE THAT WAS WRONG, CORRECTED AT MERGE TIME: when this pin was first written the
    // 'deadline_changed' e-sign value looked like drift — production allowed it and no code
    // in THIS branch wrote it. It was not drift. It arrived with the e-sign deadline feature
    // on main (migration 20260731-2130), and main's EVENT_TYPES writes it. Two sessions
    // refreshed this snapshot hours apart from opposite sides of the same day: main's 203
    // was correct before the portal-send constraints existed, this 206 is correct after.
    // Kept as a reminder that "the database allows a value the code never writes" can simply
    // mean you are reading a branch that has not caught up yet — check the other side first.
    //
    // Re-pinned 2026-08-02: 206 -> 207, email_message_content_capture_status_check, which
    // arrived with the Own-Inbox content store and had been failing the gate unregistered.
    // The pin was obtained the SAME disciplined way as its predecessors — PRODUCTION was made
    // to compute its own digest, and the rewritten file was accepted only BECAUSE it matched:
    //   SELECT md5(string_agg(conname || '|' || pg_get_constraintdef(oid), E'\n' ORDER BY conname))
    //   ... WHERE nspname='public' AND contype='c';   -> 29e281e876d0dfeb7239173d0bd1811f
    // Not recomputed over this file until green. Worth stating because this refresh did NOT
    // go through scripts/snapshot-db-constraints.ts (it refuses without .env.prod.local, which
    // a sandbox session lacks): production's set was read via the production MCP connection and
    // the one missing entry added. The checksum equality is what makes that byte-equivalent to
    // a real regeneration — and is the only reason it is acceptable. A larger gap than a single
    // constraint should go through the real script, not this route.
    //
    // Re-pinned 2026-08-09: 207 -> 210, the two WS-C migrations Antonio applied by hand
    // (the payer→client map's two rules, the tranche pair rule) plus payments' category list
    // widened with 'setup_tranche'. Same route as its two predecessors and for the same
    // reason — this worktree has no .env.prod.local, and fetching production credentials to
    // read a list of allowed strings is precisely the exposure the committed-snapshot design
    // avoids. Production was made to compute its own digest and the rewritten file was
    // accepted only BECAUSE it matched; the refresh script REFUSED to write on mismatch, so a
    // mistyped or invented definition could not have reached this file:
    //   -> 39916b7ce4711871c2416ae118985559
    expect(checksumDefs(prodConstraints())).toBe("39916b7ce4711871c2416ae118985559")
  })
})

describe("the committed production snapshot", () => {
  it("is internally consistent (checksum and count match its own contents)", () => {
    expect(verifySnapshotIntegrity()).toEqual({ ok: true })
  })

  it("holds production's full constraint set", () => {
    // 190 -> 194 -> 200 -> 202: production keeps gaining CHECK constraints between snapshots
    // (prod DDL is applied by hand), and a stale file hides them — the 07-27 refresh
    // surfaced three unregistered constrained columns that had been invisible since 07-21.
    // 07-29: +2 from the S-corp books table. Re-pinned in the same change that regenerated
    // the file.
    // 07-31: 202 -> 203. The e-sign migration REPLACED a constraint rather than adding
    // one, so the count should not have moved at all — it did, which is how the refresh
    // surfaced staff_note_replies_body_check sitting on production unrecorded since
    // 07-29. Exactly the rot this file's own readme warns about, caught by refreshing.
    // 07-31 (later): 203 -> 206, the three worker_prepared_sends constraints Antonio applied
    // to production for the portal-send card. The count moved by exactly the three added, so
    // nothing else appeared this time — but the DEFINITIONS had drifted anyway
    // (esign_events_type_check gained 'deadline_changed' on production by hand), which a count
    // check alone cannot see. That is why the digest above is pinned to production's own value.
    // 08-02: 206 -> 207, email_message_content_capture_status_check. The count moved by
    // exactly the one added, so nothing else had accumulated unrecorded in the two days
    // since the previous refresh — and that fact is WHY this one could be done as a
    // single-entry addition verified by checksum instead of a full regeneration.
    // 08-09: 207 -> 210, the two WS-C migrations. The count moved by exactly the three added
    // (payer_client_map's two rules + payments_tranche_pair_check) with one definition widened
    // rather than added, so a full week of hand-applied production DDL accumulated NOTHING
    // unrecorded — which is again what made a delta refresh verified by digest legitimate
    // instead of requiring a full regeneration.
    expect(prodSnapshotMeta().count).toBe(210)
    expect(Object.keys(prodConstraints())).toHaveLength(210)
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
