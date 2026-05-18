/**
 * Catalog validity checker — asserts that every `task_workflows` row references
 * only code-side identifiers that actually exist (handlers, attachment
 * templates, task_meta schemas).
 *
 * Motivation: today these references are validated only at runtime — a
 * misspelled handler slug surfaces as a 500 from `/api/tasks/[id]/action`, an
 * unknown attachment template shows a silent "Unknown attachment template"
 * banner. Both classes of bug ship invisibly. Running this validator over the
 * sandbox catalog before each production push catches them at deploy gate.
 *
 * Pure function. Input = the rows (you fetch them however — execute_sql,
 * `psql`, an integration test fixture). Output = a list of issue strings.
 * Caller decides what to do with non-empty issues (fail a CI step, print and
 * warn, etc.).
 */

import { parseWorkflowSnapshot, buildSnapshotForStorage } from "@/lib/tasks/workflow-snapshot-schema"
import { getRegisteredHandlerSlugs } from "@/lib/tasks/workflow-registry"
import { getRegisteredSchemaNames } from "@/lib/tasks/workflow-schemas"
import { getHandlerParamSchema } from "@/lib/tasks/workflow-handler-params"
import { parseTriggeredBy } from "@/lib/tasks/workflow-trigger-schema"

export interface CatalogWorkflowRow {
  slug: string
  status?: string | null
  metadata: Record<string, unknown> | null | undefined
}

/**
 * Validity-check dependencies. Injected so the validator stays a pure .ts
 * function — no transitive import of the React (.tsx) attachment-template
 * registry, which would prevent vitest from running it in the Node-only unit
 * suite. Server callers (e.g. a deploy-gate script) pass the real registries;
 * unit tests pass synthetic ones.
 */
export interface CatalogValidityDeps {
  /** Names of registered attachment templates. Pass [] to skip the check. */
  attachmentTemplateNames: ReadonlyArray<string>
  /** Optional override for the handler-name list. Defaults to the registry. */
  handlerNames?: ReadonlyArray<string>
  /** Optional override for the schema-name list. Defaults to the registry. */
  schemaNames?: ReadonlyArray<string>
}

export interface CatalogValidityIssue {
  slug: string
  kind:
    | "metadata_missing"
    | "snapshot_malformed"
    | "handler_unknown"
    | "attachment_template_unknown"
    | "task_meta_schema_unknown"
    | "handler_params_invalid"
    | "ambiguous_trigger"
  detail: string
}

export interface CatalogValidityReport {
  scanned: number
  passed: number
  issues: CatalogValidityIssue[]
}

/**
 * Run the validity checks against a set of catalog rows. Caller pre-filters
 * by status (typically `status='active'`).
 */
export function validateWorkflowCatalog(
  rows: CatalogWorkflowRow[],
  deps: CatalogValidityDeps,
): CatalogValidityReport {
  const issues: CatalogValidityIssue[] = []
  const handlerSet = new Set(deps.handlerNames ?? getRegisteredHandlerSlugs())
  const schemaSet = new Set(deps.schemaNames ?? getRegisteredSchemaNames())
  const templateSet = new Set(deps.attachmentTemplateNames)

  for (const row of rows) {
    if (!row.metadata || typeof row.metadata !== "object") {
      issues.push({ slug: row.slug, kind: "metadata_missing", detail: "metadata is null or not an object" })
      continue
    }

    // 1. Snapshot must parse — same check the dispatcher runs at spawn time
    //    and the TaskCard runs at render time. Catches missing slug, malformed
    //    actions[], wrong types, etc.
    let snapshot: ReturnType<typeof parseWorkflowSnapshot>
    try {
      snapshot = parseWorkflowSnapshot(buildSnapshotForStorage({ slug: row.slug, metadata: row.metadata }))
    } catch (err) {
      issues.push({
        slug: row.slug,
        kind: "snapshot_malformed",
        detail: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    // 2. Every action's handler must be registered.
    //    AND its handler_params must parse against the handler's schema (when
    //    one is registered — schema-less handlers skip the params check).
    for (const action of snapshot.actions) {
      if (!handlerSet.has(action.handler)) {
        issues.push({
          slug: row.slug,
          kind: "handler_unknown",
          detail: `action '${action.slug}' references unknown handler '${action.handler}'`,
        })
        continue
      }
      const paramSchema = getHandlerParamSchema(action.handler)
      if (paramSchema) {
        const parsed = paramSchema.safeParse(action.handler_params ?? {})
        if (!parsed.success) {
          issues.push({
            slug: row.slug,
            kind: "handler_params_invalid",
            detail: `action '${action.slug}' (handler '${action.handler}'): ${parsed.error.message}`,
          })
        }
      }
    }

    // 3. attachment_template (if set) must be in the registry.
    if (snapshot.attachment_template) {
      if (!templateSet.has(snapshot.attachment_template)) {
        issues.push({
          slug: row.slug,
          kind: "attachment_template_unknown",
          detail: `attachment_template '${snapshot.attachment_template}' is not in the component registry`,
        })
      }
    }

    // 4. task_meta_schema (if set) must be in the schema registry.
    if (snapshot.task_meta_schema) {
      if (!schemaSet.has(snapshot.task_meta_schema)) {
        issues.push({
          slug: row.slug,
          kind: "task_meta_schema_unknown",
          detail: `task_meta_schema '${snapshot.task_meta_schema}' is not in the schema registry`,
        })
      }
    }
  }

  // 5. Ambiguous trigger detection — two active workflows whose triggered_by
  //    predicates could match the same event would make the dispatcher pick
  //    no-spawn (`reason='ambiguous'`) and fall back to legacy plain tasks.
  //    Catalog data error — flag at validity time.
  //
  //    Grouping key: source + (table || '') + canonical filter JSON. Two rows
  //    with the same key are an ambiguous match candidate set.
  const triggerGroups = new Map<string, string[]>()
  for (const row of rows) {
    if (!row.metadata || typeof row.metadata !== "object") continue
    const trig = parseTriggeredBy((row.metadata as Record<string, unknown>).triggered_by)
    if (!trig) continue
    const filterKey = JSON.stringify(trig.filter ?? {})
    const tableKey = "table" in trig && typeof trig.table === "string" ? trig.table : ""
    const key = `${trig.source}::${tableKey}::${filterKey}`
    const group = triggerGroups.get(key) ?? []
    group.push(row.slug)
    triggerGroups.set(key, group)
  }
  triggerGroups.forEach((slugs, key) => {
    if (slugs.length < 2) return
    for (const slug of slugs) {
      issues.push({
        slug,
        kind: "ambiguous_trigger",
        detail: `Two or more active workflows match the same trigger (${key}): ${slugs.join(", ")}. Dispatcher will return reason='ambiguous' for this event and fall back to legacy task creation. Fix the catalog so only one workflow matches any given event shape.`,
      })
    }
  })

  return {
    scanned: rows.length,
    passed: rows.length - new Set(issues.map((i) => i.slug)).size,
    issues,
  }
}
