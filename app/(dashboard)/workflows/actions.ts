"use server"

/**
 * Server actions for the /workflows editor.
 *
 * Save semantics:
 *   - Save Draft → status='draft' (dispatcher ignores; persists across sessions).
 *   - Publish → run validateWorkflowCatalog over the (newly-applied) catalog;
 *     if clean, status='active'. If any issue, return errors to UI without
 *     changing status.
 *
 * Concurrency: every save passes `expectedUpdatedAt` (the row's updated_at
 * as it was when the editor opened). updateMetadata throws STALE_EDIT if the
 * row changed — UI prompts to reload.
 *
 * Audit: every save writes a `metadata_changed` row to catalog_decision_log
 * via the framework helper.
 */

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { isAdmin } from "@/lib/auth"
import {
  addEntry,
  getEntry,
  listEntries,
  updateMetadata,
  type Actor,
  type CatalogEntry,
} from "@/lib/catalog/framework"
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  validateWorkflowCatalog,
  type CatalogValidityIssue,
} from "@/lib/tasks/catalog-validity"
import { getRegisteredHandlerSlugs } from "@/lib/tasks/workflow-registry"
import { getRegisteredSchemaNames } from "@/lib/tasks/workflow-schemas"
import { getRegisteredAttachmentTemplateNames } from "@/components/tasks/attachment-templates"

const CATALOG_ID = "task_workflows"

export type WorkflowAction = "save_draft" | "publish"

export interface SaveResult {
  ok: boolean
  /** New row state on success (so the client refreshes its baseline updated_at). */
  entry?: CatalogEntry
  /** Single error message — stale edit, server error, etc. */
  error?: string
  /** Per-row issues from the validity gate (Publish only). */
  validityIssues?: CatalogValidityIssue[]
}

async function requireAdminActor(): Promise<Actor> {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    throw new Error("Admin access required")
  }
  return {
    kind: "ui",
    userId: user.id,
  }
}

function reasonFor(slug: string, action: WorkflowAction): string {
  return `editor:${action} ${slug}`
}

/**
 * Validate a draft against the catalog gate. Used as a precondition for
 * Publish — but useful from the UI as a "check now" affordance too.
 *
 * Passes the proposed-after state in place of the existing row so the gate
 * sees the changes we're about to publish, plus all OTHER active rows for
 * the ambiguous-trigger check.
 */
export async function validateWorkflow(
  slug: string,
  proposedMetadata: Record<string, unknown>,
): Promise<{ ok: boolean; issues: CatalogValidityIssue[] }> {
  await requireAdminActor()
  const existing = await listEntries(CATALOG_ID, { includeDeprecated: true })
  // Replace (or append) the row under edit so the gate validates the proposed
  // state. Filter to active-equivalent for the ambiguous-trigger check —
  // drafts and deprecated don't fire so they don't compete for triggers.
  const merged = existing.map((e) =>
    e.slug === slug
      ? { slug: e.slug, status: "active" as const, metadata: proposedMetadata }
      : { slug: e.slug, status: e.status, metadata: e.metadata },
  )
  if (!existing.some((e) => e.slug === slug)) {
    merged.push({ slug, status: "active", metadata: proposedMetadata })
  }
  const activeOnly = merged.filter((m) => m.status === "active")
  const report = validateWorkflowCatalog(activeOnly, {
    attachmentTemplateNames: getRegisteredAttachmentTemplateNames(),
    handlerNames: getRegisteredHandlerSlugs(),
    schemaNames: getRegisteredSchemaNames(),
  })
  return { ok: report.issues.length === 0, issues: report.issues }
}

/**
 * Create a brand-new workflow row in 'draft' status.
 * Slug must be unique within task_workflows.
 */
export async function createWorkflow(
  slug: string,
  draftMetadata: Record<string, unknown>,
): Promise<SaveResult> {
  try {
    const actor = await requireAdminActor()
    if (!slug || !slug.match(/^[a-z0-9_]+$/)) {
      return { ok: false, error: "Slug must be lowercase letters/numbers/underscores only." }
    }
    const existing = await getEntry(CATALOG_ID, slug)
    if (existing) {
      return { ok: false, error: `Workflow '${slug}' already exists. Pick a different slug.` }
    }
    const labelAdmin =
      typeof draftMetadata.label_admin === "string" && draftMetadata.label_admin
        ? draftMetadata.label_admin
        : slug
    const entry = await addEntry(
      CATALOG_ID,
      {
        slug,
        display_name: labelAdmin,
        status: "draft",
        metadata: draftMetadata,
      },
      reasonFor(slug, "save_draft"),
      actor,
    )
    revalidatePath("/workflows")
    return { ok: true, entry }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Save changes to an existing workflow's metadata WITHOUT changing its
 * publish status. Used by Save Draft on both active + draft rows.
 *
 * STALE_EDIT detection: pass the entry's updated_at as observed by the editor.
 */
export async function saveWorkflowDraft(
  entryId: string,
  draftMetadata: Record<string, unknown>,
  expectedUpdatedAt: string,
): Promise<SaveResult> {
  try {
    const actor = await requireAdminActor()
    const existing = await supabaseAdmin
      .from("catalog_entries")
      .select("slug, catalog_id")
      .eq("id", entryId)
      .single()
    const slug = (existing.data as { slug?: string } | null)?.slug ?? "?"
    const entry = await updateMetadata(
      entryId,
      draftMetadata,
      reasonFor(slug, "save_draft"),
      actor,
      { expectedUpdatedAt },
    )
    revalidatePath("/workflows")
    revalidatePath(`/workflows/${slug}`)
    return { ok: true, entry }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}

/**
 * Publish: run the validity gate against the proposed state; if clean,
 * write metadata + flip status='active'. If issues, return them so the
 * editor can show inline.
 */
export async function publishWorkflow(
  entryId: string,
  proposedMetadata: Record<string, unknown>,
  expectedUpdatedAt: string,
): Promise<SaveResult> {
  try {
    const actor = await requireAdminActor()
    const existing = await supabaseAdmin
      .from("catalog_entries")
      .select("slug")
      .eq("id", entryId)
      .single()
    const slug = (existing.data as { slug?: string } | null)?.slug ?? "?"

    const { ok, issues } = await validateWorkflow(slug, proposedMetadata)
    if (!ok) {
      return { ok: false, error: "Validation failed — fix issues and try again.", validityIssues: issues }
    }

    const entry = await updateMetadata(
      entryId,
      proposedMetadata,
      reasonFor(slug, "publish"),
      actor,
      { expectedUpdatedAt, status: "active" },
    )
    revalidatePath("/workflows")
    revalidatePath(`/workflows/${slug}`)
    return { ok: true, entry }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Count active in-flight tasks for a workflow (Not Done + Not Cancelled).
 * Surfaced as a Publish warning so the operator understands that in-flight
 * tasks keep their pinned snapshot — only new tasks pick up the edits.
 */
export async function countInFlightTasks(workflowSlug: string): Promise<number> {
  await requireAdminActor()
  const { count } = await supabaseAdmin
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("workflow_slug" as never, workflowSlug as never)
    .not("status", "in", "(Done,Cancelled)")
  return count ?? 0
}
