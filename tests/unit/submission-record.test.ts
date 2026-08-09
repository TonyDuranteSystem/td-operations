/**
 * Guards the portal wizard-submit record builder (lib/portal/submission-record.ts).
 *
 * The headline test ("never emits a column the table doesn't have") is the
 * build-time backstop for the bug class that hit twice in production:
 *   - entity_type sent to itin/closure (silent ITIN drop, 2026-04)
 *   - account_id sent to formation (false "submission failed" + auto-chain
 *     never ran, 2026-06)
 *
 * It cross-checks the columns buildSubmissionRecord can emit for EVERY
 * submission table the route writes against the generated DB types
 * (lib/database.types.ts, regenerated on every push). If a column is added,
 * removed, or renamed in the database and the builder drifts, this fails in
 * CI/pre-push — loudly, offline — instead of as a 500 to a real client.
 */

import { describe, it, expect } from "vitest"
import {
  buildSubmissionRecord,
  type SubmissionRecordInput,
} from "@/lib/portal/submission-record"
import { SUBMISSION_TABLES } from "@/lib/portal/wizard-map"
import { loadTableColumns } from "@/lib/db-columns"

// Maximal input: every optional field populated, so the builder emits the
// widest possible column set for whichever table is passed.
const MAXIMAL_INPUT: SubmissionRecordInput = {
  token: "portal-test-2026",
  contact_id: "00000000-0000-0000-0000-000000000001",
  account_id: "00000000-0000-0000-0000-000000000002",
  lead_id: "00000000-0000-0000-0000-000000000003",
  entity_type: "MMLLC",
  submitted_data: { llc_name_1: "Test LLC" },
  upload_paths: ["a/b.pdf"],
  tax_year: 2026,
}

// Distinct submission tables the route actually writes to.
const SUBMISSION_TABLE_NAMES = [...new Set(Object.values(SUBMISSION_TABLES))]

describe("buildSubmissionRecord — column set never exceeds the real table schema", () => {
  const columnsByTable = loadTableColumns()

  it("parsed the generated types (sanity)", () => {
    expect(columnsByTable.size).toBeGreaterThan(0)
  })

  for (const table of SUBMISSION_TABLE_NAMES) {
    it(`${table}: every emitted column exists on the table`, () => {
      const actualColumns = columnsByTable.get(table)
      expect(actualColumns, `${table} not found in lib/database.types.ts`).toBeTruthy()

      const record = buildSubmissionRecord(table, MAXIMAL_INPUT)
      const ghostColumns = Object.keys(record).filter((c) => !actualColumns!.has(c))
      expect(
        ghostColumns,
        `${table}: builder emits column(s) the table does not have: ${ghostColumns.join(", ")}`,
      ).toEqual([])
    })
  }
})

describe("buildSubmissionRecord — per-table column rules", () => {
  it("always includes the shared required columns", () => {
    const r = buildSubmissionRecord("onboarding_submissions", MAXIMAL_INPUT)
    for (const key of [
      "token",
      "contact_id",
      "language",
      "prefilled_data",
      "submitted_data",
      "changed_fields",
      "upload_paths",
      "status",
    ]) {
      expect(r).toHaveProperty(key)
    }
    expect(r.status).toBe("completed")
    expect(r.language).toBe("en")
  })

  it("formation: omits account_id, keeps lead_id and entity_type", () => {
    const r = buildSubmissionRecord("formation_submissions", MAXIMAL_INPUT)
    expect(r).not.toHaveProperty("account_id")
    expect(r).toHaveProperty("lead_id")
    expect(r).toHaveProperty("entity_type")
    expect(r).not.toHaveProperty("tax_year")
  })

  it("tax_return: omits lead_id, keeps account_id, entity_type and tax_year", () => {
    const r = buildSubmissionRecord("tax_return_submissions", MAXIMAL_INPUT)
    expect(r).not.toHaveProperty("lead_id")
    expect(r).toHaveProperty("account_id")
    expect(r).toHaveProperty("entity_type")
    expect(r.tax_year).toBe(2026)
  })

  it("itin: omits entity_type, keeps account_id and lead_id", () => {
    const r = buildSubmissionRecord("itin_submissions", MAXIMAL_INPUT)
    expect(r).not.toHaveProperty("entity_type")
    expect(r).toHaveProperty("account_id")
    expect(r).toHaveProperty("lead_id")
  })

  it("closure: omits entity_type, keeps account_id and lead_id", () => {
    const r = buildSubmissionRecord("closure_submissions", MAXIMAL_INPUT)
    expect(r).not.toHaveProperty("entity_type")
    expect(r).toHaveProperty("account_id")
    expect(r).toHaveProperty("lead_id")
  })

  // Replaces an assertion that entity_type "falls back to SMLLC when not
  // provided". That fallback was a defect, not a feature: formation
  // materialization reads this column back as one of its entity-type sources,
  // so a fabricated 'SMLLC' could later be mistaken for evidence of what the
  // client actually bought — a guess confirming itself. A multi-member client
  // whose form rendered single-member had that wrong shape written here.
  // NULL keeps the source honestly empty so the signed contract decides.
  // Antonio, 2026-08-09; dev job fc69557f.
  it("formation: entity_type is written as NULL when not provided — never guessed", () => {
    const r = buildSubmissionRecord("formation_submissions", { ...MAXIMAL_INPUT, entity_type: null })
    expect(r.entity_type).toBeNull()
  })

  // entity_type is NOT NULL on onboarding / tax_return / company_info and
  // nullable only on formation_submissions. Writing NULL to the others is a
  // 23502 → false "submission failed" + skipped auto-chain. Omit instead.
  it("non-formation: entity_type is OMITTED when not provided, never NULL", () => {
    for (const t of ["onboarding_submissions", "tax_return_submissions", "company_info_submissions"]) {
      const r = buildSubmissionRecord(t, { ...MAXIMAL_INPUT, entity_type: null })
      expect(r).not.toHaveProperty("entity_type")
    }
  })

  it("entity_type is passed through unchanged when provided", () => {
    const r = buildSubmissionRecord("formation_submissions", { ...MAXIMAL_INPUT, entity_type: "MMLLC" })
    expect(r.entity_type).toBe("MMLLC")
  })

  it("tax_year is omitted when null even on tax_return", () => {
    const r = buildSubmissionRecord("tax_return_submissions", { ...MAXIMAL_INPUT, tax_year: null })
    expect(r).not.toHaveProperty("tax_year")
  })
})
