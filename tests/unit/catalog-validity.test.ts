/**
 * Catalog validity tests — exercises the validator's logic with synthetic
 * good/bad rows. The real "is sandbox catalog clean?" check is run by
 * `scripts/check-catalog-validity.ts` (separate dev tool, not in the unit
 * suite) so vitest stays DB-free.
 */

import { describe, it, expect } from "vitest"
import { validateWorkflowCatalog, type CatalogWorkflowRow } from "@/lib/tasks/catalog-validity"

// Synthetic registries used by every test below — avoids depending on the
// real handler/schema registries so the test stays insulated from churn.
const DEPS = {
  attachmentTemplateNames: ["pdf_list"] as const,
  handlerNames: ["task.cancel"] as const,
  schemaNames: ["itin_review_v1"] as const,
}

// Minimal valid metadata. Uses a real handler ("task.cancel") + real schema
// (the dispatcher rejects unknown schemas at runtime; this fixture must reflect
// real registered values or the test becomes meaningless).
function goodMetadata(handler = "task.cancel"): Record<string, unknown> {
  return {
    version: 1,
    label_admin: "Test workflow",
    permission: { role_in: ["admin"] },
    actions: [
      {
        slug: "primary",
        label_admin: "Do the thing",
        permission: { role_in: ["admin"] },
        handler,
        on_success_status: "Done",
      },
    ],
  }
}

describe("validateWorkflowCatalog", () => {
  it("passes a clean row", () => {
    const rows: CatalogWorkflowRow[] = [{ slug: "test_workflow", metadata: goodMetadata() }]
    const report = validateWorkflowCatalog(rows, DEPS)
    expect(report.scanned).toBe(1)
    expect(report.passed).toBe(1)
    expect(report.issues).toEqual([])
  })

  it("flags null metadata", () => {
    const rows: CatalogWorkflowRow[] = [{ slug: "broken", metadata: null }]
    const report = validateWorkflowCatalog(rows, DEPS)
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0].kind).toBe("metadata_missing")
  })

  it("flags malformed snapshot (missing required field)", () => {
    const bad = goodMetadata()
    delete (bad as Record<string, unknown>).version
    const report = validateWorkflowCatalog([{ slug: "no_version", metadata: bad }], DEPS)
    expect(report.issues[0].kind).toBe("snapshot_malformed")
    expect(report.issues[0].slug).toBe("no_version")
  })

  it("flags unknown handler slug", () => {
    const rows: CatalogWorkflowRow[] = [
      { slug: "fake_handler", metadata: goodMetadata("not.a.real.handler") },
    ]
    const report = validateWorkflowCatalog(rows, DEPS)
    expect(report.issues.some((i) => i.kind === "handler_unknown")).toBe(true)
  })

  it("flags unknown attachment_template", () => {
    const meta = goodMetadata()
    meta.attachment_template = "not_a_real_template"
    const report = validateWorkflowCatalog([{ slug: "bad_template", metadata: meta }], DEPS)
    expect(report.issues.some((i) => i.kind === "attachment_template_unknown")).toBe(true)
  })

  it("flags unknown task_meta_schema", () => {
    const meta = goodMetadata()
    meta.task_meta_schema = "not_a_real_schema_v1"
    const report = validateWorkflowCatalog([{ slug: "bad_schema", metadata: meta }], DEPS)
    expect(report.issues.some((i) => i.kind === "task_meta_schema_unknown")).toBe(true)
  })

  it("aggregates multiple issues across rows", () => {
    const rows: CatalogWorkflowRow[] = [
      { slug: "ok", metadata: goodMetadata() },
      { slug: "bad1", metadata: null },
      { slug: "bad2", metadata: goodMetadata("not.real") },
    ]
    const report = validateWorkflowCatalog(rows, DEPS)
    expect(report.scanned).toBe(3)
    expect(report.passed).toBe(1) // only 'ok' has zero issues
    expect(report.issues.length).toBeGreaterThanOrEqual(2)
  })

  it("does not flag attachment_template when absent", () => {
    const report = validateWorkflowCatalog([{ slug: "no_attach", metadata: goodMetadata() }], DEPS)
    expect(report.issues.filter((i) => i.kind === "attachment_template_unknown")).toEqual([])
  })

  it("does not flag task_meta_schema when absent", () => {
    const report = validateWorkflowCatalog([{ slug: "no_schema", metadata: goodMetadata() }], DEPS)
    expect(report.issues.filter((i) => i.kind === "task_meta_schema_unknown")).toEqual([])
  })
})

describe("validateWorkflowCatalog — handler_params_invalid", () => {
  it("flags an action with handler_params missing a required field", () => {
    const meta = goodMetadata()
    meta.actions = [
      {
        slug: "advance",
        label_admin: "Advance",
        permission: { role_in: ["admin"] },
        handler: "chain.advance_sd_stage",
        handler_params: {},
        on_success_status: "Done",
      },
    ]
    const report = validateWorkflowCatalog(
      [{ slug: "bad_params", metadata: meta }],
      {
        attachmentTemplateNames: [],
        handlerNames: ["chain.advance_sd_stage"],
        schemaNames: [],
      },
    )
    expect(report.issues.some((i) => i.kind === "handler_params_invalid")).toBe(true)
    expect(report.issues[0].detail).toMatch(/target_stage|required|invalid/i)
  })

  it("accepts an action with valid handler_params", () => {
    const meta = goodMetadata()
    meta.actions = [
      {
        slug: "advance",
        label_admin: "Advance",
        permission: { role_in: ["admin"] },
        handler: "chain.advance_sd_stage",
        handler_params: { target_stage: "EIN Application" },
        on_success_status: "Done",
      },
    ]
    const report = validateWorkflowCatalog(
      [{ slug: "ok_params", metadata: meta }],
      {
        attachmentTemplateNames: [],
        handlerNames: ["chain.advance_sd_stage"],
        schemaNames: [],
      },
    )
    expect(report.issues.filter((i) => i.kind === "handler_params_invalid")).toEqual([])
  })
})

describe("validateWorkflowCatalog — ambiguous_trigger", () => {
  function withTrigger(
    slug: string,
    trig: Record<string, unknown>,
  ): CatalogWorkflowRow {
    const meta = goodMetadata()
    meta.triggered_by = trig
    return { slug, metadata: meta }
  }

  it("flags two active workflows that match the same form_submission trigger", () => {
    const rows: CatalogWorkflowRow[] = [
      withTrigger("a", {
        source: "form_submission",
        table: "banking_submissions",
        filter: { provider: "payset" },
      }),
      withTrigger("b", {
        source: "form_submission",
        table: "banking_submissions",
        filter: { provider: "payset" },
      }),
    ]
    const report = validateWorkflowCatalog(rows, DEPS)
    const ambig = report.issues.filter((i) => i.kind === "ambiguous_trigger")
    expect(ambig.length).toBe(2)
    expect(ambig.map((i) => i.slug).sort()).toEqual(["a", "b"])
  })

  it("flags two active workflows that match the same sd_created trigger", () => {
    const rows: CatalogWorkflowRow[] = [
      withTrigger("c1", {
        source: "sd_created",
        filter: { service_type: "Company Formation" },
      }),
      withTrigger("c2", {
        source: "sd_created",
        filter: { service_type: "Company Formation" },
      }),
    ]
    const report = validateWorkflowCatalog(rows, DEPS)
    expect(report.issues.some((i) => i.kind === "ambiguous_trigger")).toBe(true)
  })

  it("does NOT flag workflows with distinct filters on the same table", () => {
    const rows: CatalogWorkflowRow[] = [
      withTrigger("d1", {
        source: "form_submission",
        table: "banking_submissions",
        filter: { provider: "payset" },
      }),
      withTrigger("d2", {
        source: "form_submission",
        table: "banking_submissions",
        filter: { provider: "relay" },
      }),
    ]
    const report = validateWorkflowCatalog(rows, DEPS)
    expect(report.issues.filter((i) => i.kind === "ambiguous_trigger")).toEqual([])
  })

  it("ignores rows without a triggered_by (chain-spawned workflows)", () => {
    const rows: CatalogWorkflowRow[] = [
      { slug: "chain1", metadata: goodMetadata() },
      { slug: "chain2", metadata: goodMetadata() },
    ]
    const report = validateWorkflowCatalog(rows, DEPS)
    expect(report.issues.filter((i) => i.kind === "ambiguous_trigger")).toEqual([])
  })
})
