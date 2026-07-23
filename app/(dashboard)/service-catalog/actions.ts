"use server"

/**
 * Server actions for the unified Service Catalog editor.
 *
 * Antonio's goal: one place to add a new service AND define its stages + workflow.
 * Today those live in three tables (service_catalog, pipeline_stages, catalog_entries
 * with catalog_id='task_workflows'). This action wraps writes across all of them
 * into a single Save flow from the user's perspective.
 *
 * Phase 8a (this commit): writes service_catalog + pipeline_stages.
 * Phase 8b: extends to also write the workflow row when defined inline.
 */

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { isAdmin } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  getStagesForService,
  replaceStagesForService,
  validateStageDraft,
  type StageRow,
} from "@/lib/services/stages"
import {
  addEntry,
  getEntry,
  listEntries,
  updateMetadata,
  type Actor,
} from "@/lib/catalog/framework"
import {
  validateWorkflowCatalog,
  type CatalogValidityIssue,
} from "@/lib/tasks/catalog-validity"
import { getRegisteredHandlerSlugs } from "@/lib/tasks/workflow-registry"
import { getRegisteredSchemaNames } from "@/lib/tasks/workflow-schemas"
import { getRegisteredAttachmentTemplateNames } from "@/components/tasks/attachment-templates"

const WORKFLOWS_CATALOG_ID = "task_workflows"

interface ActorOpts {
  userId: string | null
}

export interface ServiceBasicsDraft {
  id?: string | null
  name: string
  slug: string
  category: string
  pipeline: string | null
  contract_type: string | null
  has_annual: boolean
  default_price: number | null
  default_currency: string
  description: string | null
}

export interface ServiceDraft {
  basics: ServiceBasicsDraft
  stages: StageRow[]
  workflow: ServiceWorkflowDraft | null
  /**
   * The stage row ids this editor had when the page loaded. Lets the save
   * refuse when someone else added a stage in the meantime, instead of deleting
   * it as "absent from the submission" — Antonio runs the CRM on desktop and
   * phone at once, and /config edits the same rows.
   */
  knownStageIds?: string[]
}

export interface ServiceWorkflowDraft {
  /** task_workflows row slug — defaults to basics.slug if unset. */
  slug: string
  label_admin: string
  default_assignee: string
  default_priority: "Urgent" | "High" | "Normal" | "Low"
  task_title_template: string
  description_template: string
  sla: {
    warn_hours: number | null
    escalate_hours: number | null
    escalate_to: string
    auto_reassign: boolean
    notify_email_to: string
  } | null
  actions: Array<Record<string, unknown>>
  /** Whether to publish (status='active') on save. False → save as draft. */
  publish: boolean
  /** Snapshot of updated_at when loaded — used for stale-edit detection. */
  expectedUpdatedAt?: string | null
  /** Existing catalog row id; undefined → create new. */
  existingId?: string | null
}

export interface SaveResult {
  ok: boolean
  service?: { id: string; slug: string }
  workflowIssues?: CatalogValidityIssue[]
  /** Non-blocking warnings — informational, save still succeeds. */
  warnings?: string[]
  error?: string
}

/**
 * Semantic completeness checks beyond Zod validity. Returns human-readable
 * warnings the UI surfaces to the operator (non-blocking).
 *
 * Today's checks:
 *  - Stages defined but no chain.advance_sd_stage workflow action covers them
 *    → would mean Luca has no button to move past the first stage
 *  - chain.advance_sd_stage actions whose target_stage doesn't match any defined
 *    stage name → would runtime-fail when clicked
 *  - Workflow enabled but zero actions → spawned task has no buttons
 */
function buildSemanticWarnings(stages: StageRow[], workflow: ServiceWorkflowDraft | null): string[] {
  const warnings: string[] = []
  if (!workflow) return warnings

  if (workflow.actions.length === 0) {
    warnings.push("Workflow is enabled but has 0 actions — the spawned task will have no buttons.")
  }

  const stageNames = new Set(stages.map((s) => s.stage_name).filter(Boolean))
  const advanceTargets = workflow.actions
    .filter((a) => a.handler === "chain.advance_sd_stage")
    .map((a) => {
      const params = a.handler_params as { target_stage?: unknown } | undefined
      return typeof params?.target_stage === "string" ? params.target_stage : null
    })
    .filter((t): t is string => !!t)

  for (const target of advanceTargets) {
    if (!stageNames.has(target)) {
      warnings.push(
        `Action's target_stage "${target}" doesn't match any of your stages [${Array.from(stageNames).join(", ") || "(none)"}]. Clicking that button will fail at runtime.`,
      )
    }
  }

  if (stages.length > 1) {
    // Need (stages.length - 1) advance buttons to walk through them all.
    // Compare against the count of chain.advance_sd_stage actions whose
    // target_stage is in the stages list.
    const usefulAdvances = advanceTargets.filter((t) => stageNames.has(t)).length
    const needed = stages.length - 1
    if (usefulAdvances < needed) {
      warnings.push(
        `You have ${stages.length} stages but only ${usefulAdvances} advance action${usefulAdvances === 1 ? "" : "s"} that target one of your stages. To walk through all ${stages.length} stages you need ${needed} advance actions (or one per transition). Currently Luca can only advance ${usefulAdvances} time${usefulAdvances === 1 ? "" : "s"}.`,
      )
    }
  }

  return warnings
}

async function requireAdmin(): Promise<ActorOpts> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    throw new Error("Admin access required")
  }
  return { userId: user.id }
}

function actor(opts: ActorOpts): Actor {
  return { kind: "ui", userId: opts.userId }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

/**
 * Save the full service definition: basics + stages.
 * Creates the service_catalog row if missing, updates if present.
 * Replaces all pipeline_stages for the service's pipeline name.
 */
export async function saveServiceComplete(draft: ServiceDraft): Promise<SaveResult> {
  try {
    await requireAdmin()
    const basics = draft.basics

    if (!basics.name?.trim()) {
      return { ok: false, error: "Name is required." }
    }
    const slug = basics.slug?.trim() || slugify(basics.name)
    if (!slug) {
      return { ok: false, error: "Could not derive a slug from the name." }
    }

    // Validate the stages BEFORE the service row is written. This used to run
    // afterwards, inside the stage save — so a rejected save had ALREADY
    // committed the name, price and currency while telling the admin the save
    // had failed. A wrong price could go live behind an error message.
    const stageWarnings: string[] = []

    const stageProblem = validateStageDraft(draft.stages)
    if (stageProblem) {
      return { ok: false, error: stageProblem }
    }

    const row = {
      name: basics.name.trim(),
      slug,
      category: basics.category || "addon",
      pipeline: basics.pipeline?.trim() || null,
      contract_type: basics.contract_type?.trim() || null,
      has_annual: !!basics.has_annual,
      default_price: basics.default_price ?? null,
      default_currency: basics.default_currency || "USD",
      description: basics.description?.trim() || null,
      active: true,
      updated_at: new Date().toISOString(),
    }

    // The pipeline name IS the key its stages are stored under, so two services
    // must never share one. Without this check, creating a service named after
    // an existing pipeline (the natural thing to do on an "Add Service" screen)
    // hands that pipeline's stages to the new service — and an empty stage list
    // then deletes every one of them while reporting success.
    if (row.pipeline) {
      // NOT maybeSingle: if two services somehow already share a name, that
      // errors and locks BOTH of them out of saving at all. Take the first
      // match instead — the point is to stop a NEW collision, not to punish an
      // existing one.
      const { data: clashes, error: clashErr } = await supabaseAdmin
        .from("service_catalog")
        .select("id, name")
        .eq("pipeline", row.pipeline)
      if (clashErr) {
        return { ok: false, error: `Could not check the pipeline name: ${clashErr.message}` }
      }
      const other = ((clashes ?? []) as Array<{ id: string; name: string }>)
        .find(c => c.id !== basics.id) ?? null
      if (other) {
        return {
          ok: false,
          error:
            `The pipeline name "${row.pipeline}" already belongs to "${other.name}". ` +
            `Two services cannot share a pipeline — pick a different name. Nothing has been changed.`,
        }
      }
    }

    let serviceId: string
    let serviceSlug: string

    // Read the pipeline name as it stands BEFORE we overwrite it, so a rename
    // can be detected and the stages moved with it. A failure here must NOT be
    // swallowed: treating a transient read error as "no previous pipeline"
    // skips the re-key, orphans every stage under the old name and reports
    // success.
    let previousPipeline: string | null = null
    if (basics.id) {
      const { data: prior, error: priorErr } = await supabaseAdmin
        .from("service_catalog")
        .select("pipeline")
        .eq("id", basics.id)
        .maybeSingle()
      if (priorErr) {
        return { ok: false, error: `Could not read the current pipeline name: ${priorErr.message}` }
      }
      previousPipeline = (prior as { pipeline?: string | null } | null)?.pipeline ?? null
    }

    if (basics.id) {
      // service_catalog is a view (INSTEAD OF trigger handles DML); cast past generated view types — see af35ebac
      const { data, error } = await (supabaseAdmin as any)
        .from("service_catalog")
        .update(row)
        .eq("id", basics.id)
        .select("id, slug")
        .single()
      if (error || !data) {
        return { ok: false, error: error?.message ?? "Update failed" }
      }
      serviceId = data.id
      serviceSlug = data.slug
    } else {
      // Compute sort_order: max + 1 so new services land at the end.
      const { data: maxRow } = await supabaseAdmin
        .from("service_catalog")
        .select("sort_order")
        .order("sort_order", { ascending: false })
        .limit(1)
        .single()
      const sortOrder = (maxRow?.sort_order ?? 0) + 1
      // service_catalog is a view (INSTEAD OF trigger handles DML); cast past generated view types — see af35ebac
      const { data, error } = await (supabaseAdmin as any)
        .from("service_catalog")
        .insert({ ...row, sort_order: sortOrder })
        .select("id, slug")
        .single()
      if (error || !data) {
        return { ok: false, error: error?.message ?? "Insert failed" }
      }
      serviceId = data.id
      serviceSlug = data.slug
    }

    // The pipeline name IS the stages' key. If the admin renamed it, move the
    // existing rows across FIRST — otherwise the write below looks for stages
    // under a name that has none, inserts a fresh bare set, and orphans the
    // real ones (with every in-flight service delivery still pointing at the
    // old name).
    // RENAMING THE PIPELINE IS NOT AVAILABLE, deliberately (2026-07-23). The
    // pipeline name keys the stages AND every live delivery. Re-keying both is
    // two writes with no transaction between them: if the second fails, the
    // stages move and the deliveries do not, and the retry is a silent no-op
    // because the catalog row already reads the new name — leaving every
    // in-flight client on a pipeline that no longer exists, with a success
    // message. Refusing until that is atomic.
    if (basics.id && previousPipeline && row.pipeline && previousPipeline !== row.pipeline) {
      return {
        ok: false,
        error:
          `Renaming the pipeline is not available yet — "${previousPipeline}" is the key its ` +
          `steps and every live client are stored under, and moving them is not yet safe to ` +
          `interrupt. Nothing has been changed.`,
      }
    }

    // Stages — only persist when a pipeline name is set. Services without a
    // pipeline are "addon" billing-only items with no lifecycle.
    if (row.pipeline) {
      const res = await replaceStagesForService(row.pipeline, draft.stages, {
        knownStageIds: draft.knownStageIds,
      })
      stageWarnings.push(...res.warnings)
    }

    // Workflow — only persist when defined AND pipeline name is set (workflow
    // triggered_by is always sd_created with filter.service_type=pipeline).
    let workflowIssues: CatalogValidityIssue[] | undefined
    if (draft.workflow && row.pipeline) {
      const result = await saveWorkflowForService({
        actor: await requireAdmin(),
        servicePipeline: row.pipeline,
        draft: draft.workflow,
      })
      if (!result.ok && result.issues) workflowIssues = result.issues
      if (!result.ok && !result.issues) {
        return { ok: false, error: result.error ?? "Workflow save failed" }
      }
    }

    // Stage-level warnings (clients moved by a rename, buttons left pointing at
    // an old name) matter more than the semantic ones — surface them first.
    const warnings = [...stageWarnings, ...buildSemanticWarnings(draft.stages, draft.workflow)]

    revalidatePath("/service-catalog")
    revalidatePath(`/service-catalog/${serviceSlug}/edit`)
    return {
      ok: true,
      service: { id: serviceId, slug: serviceSlug },
      workflowIssues,
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Persist the workflow row for a service. Creates if missing, updates if
 * present. When draft.publish=true, runs validateWorkflowCatalog against the
 * proposed-active state; only flips status='active' if clean.
 */
async function saveWorkflowForService(args: {
  actor: ActorOpts
  servicePipeline: string
  draft: ServiceWorkflowDraft
}): Promise<{ ok: boolean; issues?: CatalogValidityIssue[]; error?: string }> {
  const { servicePipeline, draft } = args
  const slug = draft.slug?.trim() || servicePipeline.toLowerCase().replace(/[^a-z0-9_]+/g, "_") + "_workflow"

  // Build the workflow metadata payload from the draft.
  const metadata: Record<string, unknown> = {
    version: 1,
    label_admin: draft.label_admin || `${servicePipeline} Workflow`,
    permission: { role_in: ["admin", "team"] },
    actions: draft.actions,
    triggered_by: {
      source: "sd_created",
      filter: { service_type: servicePipeline },
    },
  }
  if (draft.default_assignee) metadata.default_assignee = draft.default_assignee
  metadata.default_priority = draft.default_priority
  if (draft.task_title_template) metadata.task_title_template = draft.task_title_template
  if (draft.description_template) metadata.description_template = draft.description_template
  if (draft.sla) {
    const sla: Record<string, unknown> = {}
    if (draft.sla.warn_hours !== null) sla.warn_hours = draft.sla.warn_hours
    if (draft.sla.escalate_hours !== null) sla.escalate_hours = draft.sla.escalate_hours
    if (draft.sla.escalate_to) sla.escalate_to = draft.sla.escalate_to
    if (draft.sla.auto_reassign === false) sla.auto_reassign = false
    if (draft.sla.notify_email_to) sla.notify_email_to = draft.sla.notify_email_to
    if (Object.keys(sla).length > 0) metadata.sla = sla
  }

  // Validate before publish.
  if (draft.publish) {
    const existing = await listEntries(WORKFLOWS_CATALOG_ID, { includeDeprecated: true })
    const merged = existing.map((e) =>
      e.slug === slug
        ? { slug, status: "active" as const, metadata }
        : { slug: e.slug, status: e.status, metadata: e.metadata },
    )
    if (!existing.some((e) => e.slug === slug)) {
      merged.push({ slug, status: "active", metadata })
    }
    const activeOnly = merged.filter((m) => m.status === "active")
    const report = validateWorkflowCatalog(activeOnly, {
      attachmentTemplateNames: getRegisteredAttachmentTemplateNames(),
      handlerNames: getRegisteredHandlerSlugs(),
      schemaNames: getRegisteredSchemaNames(),
    })
    if (report.issues.length > 0) {
      return { ok: false, issues: report.issues }
    }
  }

  const reason = `service-editor:${draft.publish ? "publish" : "save_draft"} ${slug}`
  const existing = draft.existingId ? null : await getEntry(WORKFLOWS_CATALOG_ID, slug)

  if (draft.existingId || existing) {
    const entryId = draft.existingId ?? existing!.id
    await updateMetadata(entryId, metadata, reason, actor(args.actor), {
      status: draft.publish ? "active" : undefined,
      expectedUpdatedAt: draft.expectedUpdatedAt ?? undefined,
    })
  } else {
    await addEntry(
      WORKFLOWS_CATALOG_ID,
      {
        slug,
        display_name: draft.label_admin || servicePipeline,
        status: draft.publish ? "active" : "draft",
        metadata,
      },
      reason,
      actor(args.actor),
    )
  }
  return { ok: true }
}

/**
 * Load a service's full state for editing: basics + stages + workflow.
 *
 * Workflow lookup: finds any active OR draft task_workflows row whose
 * triggered_by.filter.service_type matches this service's pipeline name.
 * Returns null if none exists (editor shows empty workflow section).
 */
export async function loadServiceComplete(slug: string): Promise<{
  basics: ServiceBasicsDraft | null
  stages: StageRow[]
  workflow: {
    id: string
    slug: string
    status: string
    updated_at: string | null
    metadata: Record<string, unknown>
  } | null
}> {
  await requireAdmin()
  const { data: svc } = await supabaseAdmin
    .from("service_catalog")
    .select("id, name, slug, category, pipeline, contract_type, has_annual, default_price, default_currency, description")
    .eq("slug", slug)
    .maybeSingle()
  if (!svc) return { basics: null, stages: [], workflow: null }
  const basics: ServiceBasicsDraft = {
    id: svc.id,
    name: svc.name,
    slug: svc.slug,
    category: svc.category ?? "addon",
    pipeline: svc.pipeline,
    contract_type: svc.contract_type,
    has_annual: !!svc.has_annual,
    default_price: svc.default_price,
    default_currency: svc.default_currency ?? "USD",
    description: svc.description,
  }
  const stages = svc.pipeline ? await getStagesForService(svc.pipeline) : []

  let workflow:
    | { id: string; slug: string; status: string; updated_at: string | null; metadata: Record<string, unknown> }
    | null = null
  if (svc.pipeline) {
    const { data: rows } = await supabaseAdmin
      .from("catalog_entries")
      .select("id, slug, status, updated_at, metadata")
      .eq("catalog_id", WORKFLOWS_CATALOG_ID)
      .eq("metadata->triggered_by->filter->>service_type", svc.pipeline)
      .neq("status", "deprecated")
      .limit(1)
    if (rows && rows.length > 0) {
      const r = rows[0] as { id: string; slug: string; status: string; updated_at: string | null; metadata: Record<string, unknown> }
      workflow = r
    }
  }

  return { basics, stages, workflow }
}
