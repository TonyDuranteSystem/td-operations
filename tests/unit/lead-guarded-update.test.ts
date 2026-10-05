/**
 * Guarded lead edits (dev job f3f3e237 step 2 / d26b8a7e remainder): the lead edit routes used a
 * plain update, so two people editing the same field silently overwrote each other.
 */

import { describe, it, expect } from "vitest"
import {
  normalizeCell,
  guardVerdict,
  hasExpectedValue,
  isGuardedFailure,
  updateLeadColumnGuarded,
  LEAD_CONFLICT_MESSAGE,
  type LeadDb,
} from "@/lib/leads/guarded-update"

describe("normalizeCell", () => {
  it("treats null, undefined and empty string as the same empty value", () => {
    expect(normalizeCell(null)).toBe("")
    expect(normalizeCell(undefined)).toBe("")
    expect(normalizeCell("")).toBe("")
    expect(normalizeCell("x")).toBe("x")
    expect(normalizeCell(5)).toBe("5")
  })
})

describe("guardVerdict", () => {
  it("is ok when the field still holds what the caller was editing from", () => {
    expect(guardVerdict("Call Done", "Call Done", true)).toBe("ok")
    expect(guardVerdict(null, "", true)).toBe("ok")
    expect(guardVerdict("", null, true)).toBe("ok")
  })

  it("is a conflict when the field changed since it was loaded", () => {
    expect(guardVerdict("Offer Sent", "Contacted", true)).toBe("conflict")
    expect(guardVerdict("a longer note", "", true)).toBe("conflict")
    expect(guardVerdict(null, "was something", true)).toBe("conflict")
  })

  it("never judges a caller that sent no expected value", () => {
    expect(guardVerdict("anything", undefined, false)).toBe("ok")
  })

  it("is case and whitespace exact (no silent leniency)", () => {
    expect(guardVerdict("Hello", "hello", true)).toBe("conflict")
    expect(guardVerdict("a ", "a", true)).toBe("conflict")
  })
})

describe("hasExpectedValue", () => {
  it("is true whenever the key is present, even with null or empty", () => {
    expect(hasExpectedValue({ expected_value: null }, "expected_value")).toBe(true)
    expect(hasExpectedValue({ expected_value: "" }, "expected_value")).toBe(true)
    expect(hasExpectedValue({ lead_id: "x" }, "expected_value")).toBe(false)
  })
})

/** A hand-built fake of the one query shape the helper uses. */
function fakeDb(opts: {
  row: Record<string, unknown> | null
  readError?: string
  writeRows?: unknown[] | null
  writeError?: string
}) {
  const calls = { select: [] as string[], update: [] as Record<string, unknown>[], eq: [] as Array<[string, string]> }
  const db: LeadDb = {
    from: () => ({
      select: (cols: string) => {
        calls.select.push(cols)
        return {
          eq: () => ({
            maybeSingle: async () => ({ data: opts.row, error: opts.readError ? { message: opts.readError } : null }),
          }),
        }
      },
      update: (values: Record<string, unknown>) => {
        calls.update.push(values)
        return {
          eq: (c: string, v: string) => {
            calls.eq.push([c, v])
            return {
              eq: (c2: string, v2: string) => {
                calls.eq.push([c2, v2])
                return {
                  select: async () => ({
                    data: opts.writeRows === undefined ? [{ id: "x" }] : opts.writeRows,
                    error: opts.writeError ? { message: opts.writeError } : null,
                  }),
                }
              },
            }
          },
        }
      },
    }),
  }
  return { db, calls }
}

const row = { id: "L1", updated_at: "2026-10-05T10:00:00+00:00", notes: "old notes" }

describe("updateLeadColumnGuarded", () => {
  it("writes when the field is unchanged, conditional on the updated_at it just read", async () => {
    const { db, calls } = fakeDb({ row })
    const r = await updateLeadColumnGuarded(db, {
      leadId: "L1", column: "notes", newValue: "new notes", expected: "old notes", hasExpected: true, now: () => "NOW",
    })
    expect(r).toEqual({ ok: true, previousValue: "old notes" })
    expect(calls.select[0]).toContain("notes")
    expect(calls.update[0]).toEqual({ notes: "new notes", updated_at: "NOW" })
    expect(calls.eq).toContainEqual(["updated_at", "2026-10-05T10:00:00+00:00"])
  })

  it("refuses, and does NOT write, when the field changed since it was loaded", async () => {
    const { db, calls } = fakeDb({ row })
    const r = await updateLeadColumnGuarded(db, {
      leadId: "L1", column: "notes", newValue: "mine", expected: "what I started from", hasExpected: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok && r.reason === "conflict") {
      expect(r.message).toBe(LEAD_CONFLICT_MESSAGE)
      expect(r.currentValue).toBe("old notes")
    } else throw new Error("expected a conflict")
    expect(calls.update.length).toBe(0)
  })

  it("does not refuse because of an UNRELATED change (only the edited field is compared)", async () => {
    // updated_at moved on, but the notes column still holds what this person started from
    const { db } = fakeDb({ row: { ...row, updated_at: "2099-01-01T00:00:00+00:00" } })
    const r = await updateLeadColumnGuarded(db, {
      leadId: "L1", column: "notes", newValue: "mine", expected: "old notes", hasExpected: true,
    })
    expect(r.ok).toBe(true)
  })

  it("catches a change that lands between the read and the write (0 rows matched)", async () => {
    const { db } = fakeDb({ row, writeRows: [] })
    const r = await updateLeadColumnGuarded(db, {
      leadId: "L1", column: "notes", newValue: "mine", expected: "old notes", hasExpected: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("conflict")
  })

  it("treats a null write result as nothing written", async () => {
    const { db } = fakeDb({ row, writeRows: null })
    const r = await updateLeadColumnGuarded(db, {
      leadId: "L1", column: "notes", newValue: "mine", expected: "old notes", hasExpected: true,
    })
    expect(r.ok).toBe(false)
  })

  it("an older caller with no expected value still gets the between-read-and-write protection", async () => {
    const ok = fakeDb({ row })
    expect((await updateLeadColumnGuarded(ok.db, { leadId: "L1", column: "notes", newValue: "n", hasExpected: false })).ok).toBe(true)
    const raced = fakeDb({ row, writeRows: [] })
    expect((await updateLeadColumnGuarded(raced.db, { leadId: "L1", column: "notes", newValue: "n", hasExpected: false })).ok).toBe(false)
  })

  it("reports a missing lead, and database errors, without writing", async () => {
    const missing = fakeDb({ row: null })
    const m = await updateLeadColumnGuarded(missing.db, { leadId: "L1", column: "notes", newValue: "n", hasExpected: false })
    expect(m).toMatchObject({ ok: false, reason: "not_found" })
    expect(missing.calls.update.length).toBe(0)

    const readErr = fakeDb({ row, readError: "boom" })
    expect(await updateLeadColumnGuarded(readErr.db, { leadId: "L1", column: "notes", newValue: "n", hasExpected: false }))
      .toMatchObject({ ok: false, reason: "error", message: "boom" })

    const writeErr = fakeDb({ row, writeError: "denied" })
    expect(await updateLeadColumnGuarded(writeErr.db, { leadId: "L1", column: "notes", newValue: "n", hasExpected: false }))
      .toMatchObject({ ok: false, reason: "error", message: "denied" })
  })

  it("an empty/null expected matches an empty/null column (a never-edited field)", async () => {
    const { db } = fakeDb({ row: { id: "L1", updated_at: "t", notes: null } })
    const r = await updateLeadColumnGuarded(db, { leadId: "L1", column: "notes", newValue: "first", expected: "", hasExpected: true })
    expect(r.ok).toBe(true)
  })
})

describe("isGuardedFailure", () => {
  it("narrows a failure and rejects a success", () => {
    expect(isGuardedFailure({ ok: true, previousValue: "x" })).toBe(false)
    expect(isGuardedFailure({ ok: false, reason: "error", message: "m" })).toBe(true)
    expect(isGuardedFailure({ ok: false, reason: "conflict", message: "m", currentValue: "" })).toBe(true)
  })
})
