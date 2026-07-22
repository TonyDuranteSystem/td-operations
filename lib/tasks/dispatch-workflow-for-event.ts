/**
 * Generic workflow dispatcher — finds the matching workflow for an incoming
 * event (e.g. form submission) by scanning task_workflows catalog rows whose
 * `triggered_by` predicate matches the event, then spawns the workflow task.
 *
 * Why this exists: before Slice 8, every auto-chain route hardcoded the
 * workflow slug (`/api/itin-form-completed` knew "itin_review", etc). Adding
 * a new variant or service required editing route code and deploying. The
 * dispatcher replaces that pattern: each workflow declares its own trigger
 * (data, in catalog row metadata), and the route just calls this helper.
 *
 * Adding a new workflow variant (e.g. banking_review_mercury) after this:
 *   INSERT into catalog_entries with triggered_by.filter.provider = 'mercury'.
 *   Zero code change. Zero risk of breaking sibling workflows.
 *
 * Defense-in-depth:
 *   - Malformed triggered_by rows are skipped with a warn log (not crash).
 *   - Zero matches → reason='no_trigger_match'. Caller falls back to legacy.
 *   - Multiple matches → reason='ambiguous'. Logged loud. Caller falls back.
 *     This is a CATALOG DATA error (overlapping triggers) and must be fixed
 *     in catalog; spawning a random match would be silent wrong-behavior.
 *   - Snapshot fails parseWorkflowSnapshot → reason='snapshot_invalid'. Fall back.
 *   - task_meta fails its v1 Zod schema → reason='meta_invalid'. Fall back.
 *   - createWorkflowTask fails → reason='spawn_failed'. Fall back.
 *
 * Caller-side contract: pass a `buildTaskMeta` callback that takes the matched
 * workflow def + submission row and returns a fully-formed task_meta object.
 * The dispatcher does NOT know how to build meta for any particular service —
 * that knowledge is form-specific and belongs at the call site.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { createWorkflowTask } from "@/lib/operations/task"
import { OPEN_TASK_STATUSES } from "@/lib/operations/service-delivery"
import { parseWorkflowSnapshot, buildSnapshotForStorage } from "@/lib/tasks/workflow-snapshot-schema"
import { getWorkflowSchema } from "@/lib/tasks/workflow-schemas"
import { parseTriggeredBy, matchesFilter } from "@/lib/tasks/workflow-trigger-schema"
import { interpolateStringStrict } from "@/lib/template-interpolation"
import { defaultTaskAssignee } from "@/lib/tasks/default-assignee"
import { logWorkflowDispatch } from "@/lib/tasks/workflow-dispatch-log"
import type { WorkflowSnapshot } from "@/lib/tasks/types"

/**
 * Resolve task_title / description from catalog templates (when present) with
 * graceful fallback to the caller-provided literal. The interpolation context
 * is `(submission ∪ task_meta)` — task_meta wins on key conflict because it's
 * the normalized derivative built by the caller's `build_task_meta`.
 *
 * Strict mode: any missing/empty token in the template returns null from the
 * interpolator → we fall back to the caller's literal AND log a warn so the
 * catalog row can be corrected (token typo, missing build_task_meta field).
 * Without the warn the bug is invisible — the legacy literal silently wins.
 */
function resolveTaskTextFields(
  metadata: Record<string, unknown>,
  context: Record<string, unknown>,
  fallback: { task_title: string; description?: string | null },
  workflowSlug: string,
): { task_title: string; description: string | null } {
  const titleTemplate = typeof metadata.task_title_template === "string" ? metadata.task_title_template : null
  const descTemplate = typeof metadata.description_template === "string" ? metadata.description_template : null

  let task_title = fallback.task_title
  if (titleTemplate) {
    const interpolated = interpolateStringStrict(titleTemplate, context)
    if (interpolated !== null) {
      task_title = interpolated
    } else {
      console.warn(
        `[dispatch-workflow] ${workflowSlug}: task_title_template missing token(s); falling back to caller literal. Template: ${titleTemplate}`,
      )
    }
  }

  let description: string | null = fallback.description ?? null
  if (descTemplate) {
    const interpolated = interpolateStringStrict(descTemplate, context)
    if (interpolated !== null) {
      description = interpolated
    } else {
      console.warn(
        `[dispatch-workflow] ${workflowSlug}: description_template missing token(s); falling back to caller literal. Template: ${descTemplate}`,
      )
    }
  }

  return { task_title, description }
}

export interface MatchedWorkflow {
  slug: string
  snapshot: WorkflowSnapshot
  raw_metadata: Record<string, unknown>
}

export type DispatchReason =
  | "no_trigger_match"
  | "ambiguous"
  | "snapshot_invalid"
  | "meta_invalid"
  | "spawn_failed"
  /** A workflow task with the same idempotency key already exists. task_id returned. */
  | "already_spawned"
  /** The dedup query itself failed — we do NOT spawn, rather than risk a duplicate. */
  | "dedup_check_failed"

export interface DispatchResult {
  spawned: boolean
  workflow_slug?: string
  task_id?: string
  reason?: DispatchReason
  /** When reason='ambiguous', the slugs that matched. Logged for catalog cleanup. */
  candidates?: string[]
  /** When reason='meta_invalid', the Zod error message. */
  meta_error?: string
  /** When reason='spawn_failed', the createWorkflowTask error string. */
  spawn_error?: string
}

/**
 * Idempotency check shape. When provided, the dispatcher checks for an
 * existing workflow task whose task_meta[field] equals value, and returns
 * reason='already_spawned' if found (instead of spawning a duplicate).
 *
 * Caveat: this is a client-side dedup with a small race window between the
 * check and the insert. Sufficient for webhook retries (typical retry window
 * is seconds). A DB-side unique partial index on
 * (workflow_slug, (task_meta->>'<field>')) would close the race entirely;
 * tracked as a future improvement.
 */
export interface DispatchIdempotency {
  /** Name of the task_meta key that uniquely identifies the event (e.g. "submission_id"). */
  field: string
  /** The unique value to match against task_meta[field]. */
  value: string
  /**
   * The workflow this dedup is FOR. Required whenever `field` is a value that
   * more than one workflow can carry.
   *
   * Without it the check asks "does ANY workflow task carry this value?", which
   * silently suppressed a real card for a month: `itin-form-completed` deduped
   * on `service_delivery_id`, and the `itin_data_collection` task spawned at SD
   * creation carries the SAME service_delivery_id in its sd_progress_v1 meta.
   * So the "Send wizard link" card answered for the "Review ITIN documents"
   * card, and every ITIN client from 2026-07-11 submitted their questionnaire
   * with nobody being told to review it (Marcell Bogyora ×3, Tamás Fazekas ×1 —
   * confirmed in action_log; the plain-task fallback did NOT fire either,
   * because `already_spawned` marks the workflow as handled).
   *
   * `submission_id` (banking, tax) is unique per submission and does not
   * collide — but that is luck, not design, so pass this whenever you know it.
   */
  workflow_slug?: string
}

export interface DispatchFormCompletionParams<T extends Record<string, unknown>> {
  /** The submissions table name (matched against triggered_by.table). */
  form_table: string
  /** The submission row that just completed. Filter values are checked against this. */
  submission: T
  /**
   * Builds task_meta from the matched workflow + submission. Called only when
   * exactly one workflow matches. Throws → treated as spawn_failed.
   */
  build_task_meta: (matched: MatchedWorkflow, submission: T) => Promise<Record<string, unknown>>
  /** Task fields for createWorkflowTask. */
  task_title: string
  description?: string
  assigned_to?: string
  priority?: "Urgent" | "High" | "Normal" | "Low"
  account_id?: string | null
  contact_id?: string | null
  delivery_id?: string | null
  /** Free-form actor string for action_log. */
  actor: string
  /**
   * Optional idempotency check. Recommended for ALL form-completion routes
   * because webhooks can retry. Pass the submission UUID as the value so a
   * retry of the same form completion does NOT spawn a duplicate workflow
   * task — instead returns reason='already_spawned' with the existing task_id.
   */
  idempotency?: DispatchIdempotency
}

/**
 * Find the workflow whose triggered_by matches this form-completion event
 * and spawn the corresponding workflow task. Returns spawned=false (with a
 * specific reason) when no spawn happened — the caller's responsibility is
 * to fall back to its legacy plain-task creation in that case.
 *
 * NOTE: this is the inner implementation. The exported
 * `dispatchWorkflowForFormCompletion` wraps it to record one
 * workflow_dispatch_log row (observation-only). Behavior is identical.
 */
async function dispatchWorkflowForFormCompletionInner<T extends Record<string, unknown>>(
  params: DispatchFormCompletionParams<T>,
): Promise<DispatchResult> {
  const { form_table, submission, build_task_meta, actor } = params

  // ── 0. Idempotency check — webhook retries must NOT spawn duplicates ───
  //
  // The form-completed routes are called by client-side fetch after the
  // wizard submits. A network retry triggers this route twice. Without this
  // check the dispatcher would spawn a second workflow task for the same
  // submission. Title-based dedup (used by the legacy fallback path) is not
  // applied on the workflow path, so this check is required there.
  if (params.idempotency) {
    // task_meta is typed loosely on `tasks` until lib/database.types.ts
    // regenerates (same pattern as createWorkflowTask). `workflow_slug` IS a
    // real typed column and needs no cast on .eq().
    let q = supabaseAdmin
      .from("tasks")
      .select("id, workflow_slug, status")
      .eq(`task_meta->>${params.idempotency.field}` as never, params.idempotency.value as never)
      .not("workflow_slug" as never, "is", null)

    // Scope to THIS workflow when the caller knows it — see DispatchIdempotency.
    if (params.idempotency.workflow_slug) {
      q = q.eq("workflow_slug", params.idempotency.workflow_slug)
    }

    // Only an OPEN card suppresses a new one. A CLOSED card must not: a client
    // who re-submits their wizard overwrites the generated PDFs by stable
    // filename, so staff need a fresh card telling them to re-review — without
    // this, they would mail the IRS a form that no longer matches Drive.
    // OPEN_TASK_STATUSES is exported precisely so nobody hand-rolls this list
    // again (omitting "Waiting" already caused a duplicate-formation bug).
    q = q.in("status", [...OPEN_TASK_STATUSES])

    const { data: existing, error: dedupErr } = await q.limit(1).maybeSingle()

    // FAIL CLOSED. The old `{ data }`-only destructure turned any transient
    // PostgREST failure into "no duplicate found" and spawned a second card.
    // Same fail-open dedup class that was ruled a blocker in activate-service
    // and formation-setup on 2026-07-20.
    if (dedupErr) {
      return {
        spawned: false,
        reason: "dedup_check_failed",
        spawn_error: dedupErr.message,
      }
    }

    if (existing) {
      const row = existing as unknown as { id: string; workflow_slug: string | null }
      return {
        spawned: false,
        reason: "already_spawned",
        task_id: row.id,
        workflow_slug: row.workflow_slug ?? undefined,
      }
    }
  }

  // ── 1. Fetch candidate task_workflows rows ─────────────────────────────
  //
  // Filter at SQL level by source='form_submission' AND table=form_table to
  // keep the result set tight. Then apply the in-app filter match on the
  // optional triggered_by.filter map.
  //
  // We also gate on status='active' so disabling a workflow is a 1-column
  // SQL update (catalog_entries.status='inactive') with no deploy.
  const { data: rows, error } = await supabaseAdmin
    .from("catalog_entries")
    .select("slug, metadata")
    .eq("catalog_id", "task_workflows")
    .eq("status", "active")
    .eq("metadata->triggered_by->>source", "form_submission")
    .eq("metadata->triggered_by->>table", form_table)

  if (error) {
    console.warn(`[dispatch-workflow] catalog query failed for ${form_table}:`, error.message)
    return { spawned: false, reason: "no_trigger_match" }
  }

  // ── 2. Validate each row's triggered_by + filter against the submission ─
  const matches: MatchedWorkflow[] = []
  for (const row of rows ?? []) {
    const metadata = row.metadata as Record<string, unknown> | null
    const triggered = parseTriggeredBy(metadata?.triggered_by)
    if (!triggered || triggered.source !== "form_submission") {
      console.warn(`[dispatch-workflow] ${row.slug}: malformed triggered_by, skipping`)
      continue
    }
    if (!matchesFilter(triggered.filter, submission)) continue

    // Snapshot must parse cleanly — slug stamped onto a copy so we don't
    // mutate the original metadata object.
    let snapshot: WorkflowSnapshot
    try {
      snapshot = parseWorkflowSnapshot({ ...(metadata as Record<string, unknown>), slug: row.slug })
    } catch (parseErr) {
      console.warn(
        `[dispatch-workflow] ${row.slug}: workflow_snapshot malformed, skipping:`,
        parseErr instanceof Error ? parseErr.message : String(parseErr),
      )
      continue
    }
    matches.push({ slug: row.slug, snapshot, raw_metadata: metadata as Record<string, unknown> })
  }

  // ── 3. Resolve match count ─────────────────────────────────────────────
  if (matches.length === 0) {
    return { spawned: false, reason: "no_trigger_match" }
  }
  if (matches.length > 1) {
    const slugs = matches.map((m) => m.slug)
    console.warn(
      `[dispatch-workflow] AMBIGUOUS trigger match for ${form_table}: ${slugs.join(", ")}. ` +
        `Fix catalog data so only one workflow matches this event shape.`,
    )
    return { spawned: false, reason: "ambiguous", candidates: slugs }
  }

  const matched = matches[0]

  // The caller named a workflow for the dedup; if the catalog resolved a
  // DIFFERENT one, the key we checked is not the key we are about to write —
  // so every retry would spawn another card. Loud, because this only happens
  // when catalog data has drifted (a second matching trigger, or a slug
  // renamed in the workflow editor) and it silently defeats idempotency.
  if (params.idempotency?.workflow_slug && params.idempotency.workflow_slug !== matched.slug) {
    console.warn(
      `[dispatch-workflow] idempotency slug mismatch: caller deduped on "${params.idempotency.workflow_slug}" but the catalog resolved "${matched.slug}". Retries will duplicate until the catalog or the caller is corrected.`,
    )
  }

  // ── 4. Build task_meta + validate against the workflow's v1 schema ─────
  let taskMeta: Record<string, unknown>
  try {
    taskMeta = await build_task_meta(matched, submission)
  } catch (err) {
    return {
      spawned: false,
      reason: "spawn_failed",
      workflow_slug: matched.slug,
      spawn_error: `build_task_meta threw: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const schemaName = (matched.raw_metadata.task_meta_schema as string | undefined) ?? null
  const schema = getWorkflowSchema(schemaName)
  if (schema) {
    const parsed = schema.safeParse(taskMeta)
    if (!parsed.success) {
      return {
        spawned: false,
        reason: "meta_invalid",
        workflow_slug: matched.slug,
        meta_error: parsed.error.message,
      }
    }
  }

  // ── 5. Spawn the workflow task ─────────────────────────────────────────
  const resolved = resolveTaskTextFields(
    matched.raw_metadata,
    { ...(submission as Record<string, unknown>), ...taskMeta },
    { task_title: params.task_title, description: params.description ?? null },
    matched.slug,
  )

  const spawn = await createWorkflowTask({
    workflow_slug: matched.slug,
    workflow_snapshot: buildSnapshotForStorage({ slug: matched.slug, metadata: matched.raw_metadata }),
    task_meta: taskMeta,
    task_title: resolved.task_title,
    description: resolved.description,
    assigned_to: params.assigned_to ?? (matched.raw_metadata.default_assignee as string) ?? defaultTaskAssignee(),
    priority: params.priority ?? (matched.raw_metadata.default_priority as "Urgent" | "High" | "Normal" | "Low") ?? "High",
    status: "To Do",
    account_id: params.account_id ?? null,
    contact_id: params.contact_id ?? null,
    delivery_id: params.delivery_id ?? null,
    actor,
    summary: `Workflow ${matched.slug} task created`,
    details: { workflow_slug: matched.slug, form_table },
  })

  if (!spawn.success) {
    return {
      spawned: false,
      reason: "spawn_failed",
      workflow_slug: matched.slug,
      spawn_error: spawn.error,
    }
  }

  // Emit portal-chat topic message (red unread dot) — non-fatal.
  await emitTopicForWorkflow({
    matched,
    contact_id: params.contact_id ?? null,
    account_id: params.account_id ?? null,
    task_id: spawn.task_id,
    context: { service_name: params.task_title, service_type: (submission as Record<string, unknown>).service_type as string | undefined ?? form_table, stage: undefined },
  })

  return {
    spawned: true,
    workflow_slug: matched.slug,
    task_id: spawn.task_id,
  }
}

/**
 * Public entry point for form-completion dispatch. Runs the inner dispatcher
 * unchanged, then records one observation-only workflow_dispatch_log row. The
 * log write is timeout-bounded and never throws, so it cannot change or slow
 * the dispatch outcome the caller receives.
 */
export async function dispatchWorkflowForFormCompletion<T extends Record<string, unknown>>(
  params: DispatchFormCompletionParams<T>,
): Promise<DispatchResult> {
  const result = await dispatchWorkflowForFormCompletionInner(params)

  const submissionId = (() => {
    const v = (params.submission as Record<string, unknown>).id
    return typeof v === "string" ? v : null
  })()

  await logWorkflowDispatch({
    trigger_source: "form_submission",
    event_descriptor: params.form_table,
    event_ref: params.idempotency?.value ?? submissionId,
    result,
    account_id: params.account_id ?? null,
    contact_id: params.contact_id ?? null,
    delivery_id: params.delivery_id ?? null,
    actor: params.actor,
    extra_details: { form_table: params.form_table },
  })

  return result
}

// ─── SD-created dispatcher (Slice 9) ─────────────────────────────────────

export interface DispatchSdCreatedParams {
  /** The new SD row, freshly inserted by createSD. */
  delivery: {
    id: string
    service_type: string
    stage: string | null
    account_id?: string | null
    contact_id?: string | null
    /** Human-readable service name (e.g. "Mario Rossi - Company Formation").
     *  Optional — included in the interpolation context for task_title_template
     *  so catalog rows can use `{service_name}` without needing build_task_meta
     *  to add it. */
    service_name?: string | null
  }
  /** Build task_meta for the matched workflow. The returned shape MUST satisfy
   *  the workflow's task_meta_schema Zod check. */
  build_task_meta: (matched: MatchedWorkflow) => Promise<Record<string, unknown>>
  /** Task title for the spawned workflow task. */
  task_title: string
  description?: string
  /** Free-form actor string for action_log. */
  actor: string
}

/**
 * Find the workflow whose triggered_by matches the new SD's service_type
 * (source='sd_created') and spawn the corresponding workflow task. Same
 * defensive contract as dispatchWorkflowForFormCompletion:
 *   - ambiguous match → loud log + spawned=false
 *   - no match → spawned=false (caller can ignore — many SD types have no workflow)
 *   - meta_invalid / snapshot_invalid / spawn_failed → spawned=false with reason
 *
 * Always-on idempotency: uses task_meta.service_delivery_id as the dedup key.
 * Two SD inserts for the same SD id (unlikely, but a retry could cause it)
 * → second call returns reason='already_spawned' with the existing task_id.
 *
 * NOTE: this is the inner implementation. The exported
 * `dispatchWorkflowForSdCreated` wraps it to record one
 * workflow_dispatch_log row (observation-only). Behavior is identical.
 */
async function dispatchWorkflowForSdCreatedInner(
  params: DispatchSdCreatedParams,
): Promise<DispatchResult> {
  const { delivery, build_task_meta, actor } = params

  // ── 0. Idempotency: don't spawn a 2nd workflow for the same SD ──────────
  {
    const { data: existing } = await supabaseAdmin
      .from("tasks")
      .select("id, workflow_slug")
      .eq(`task_meta->>service_delivery_id` as never, delivery.id as never)
      .not("workflow_slug" as never, "is", null)
      .limit(1)
      .maybeSingle()
    if (existing) {
      const row = existing as unknown as { id: string; workflow_slug: string | null }
      return {
        spawned: false,
        reason: "already_spawned",
        task_id: row.id,
        workflow_slug: row.workflow_slug ?? undefined,
      }
    }
  }

  // ── 1. Fetch candidate task_workflows rows for sd_created ───────────────
  const { data: rows, error } = await supabaseAdmin
    .from("catalog_entries")
    .select("slug, metadata")
    .eq("catalog_id", "task_workflows")
    .eq("status", "active")
    .eq("metadata->triggered_by->>source", "sd_created")
    // PostgREST JSONB path: keys unquoted, `->` for object navigation, `->>` for text at the end.
    .eq("metadata->triggered_by->filter->>service_type", delivery.service_type)

  if (error) {
    console.warn(`[dispatch-workflow-sd-created] catalog query failed for ${delivery.service_type}:`, error.message)
    return { spawned: false, reason: "no_trigger_match" }
  }

  // ── 2. Parse + validate ────────────────────────────────────────────────
  const matches: MatchedWorkflow[] = []
  for (const row of rows ?? []) {
    const metadata = row.metadata as Record<string, unknown> | null
    const triggered = parseTriggeredBy(metadata?.triggered_by)
    if (!triggered || triggered.source !== "sd_created") {
      console.warn(`[dispatch-workflow-sd-created] ${row.slug}: malformed triggered_by, skipping`)
      continue
    }
    // service_type already matched at SQL level; no further filter check needed.
    let snapshot: WorkflowSnapshot
    try {
      snapshot = parseWorkflowSnapshot({ ...(metadata as Record<string, unknown>), slug: row.slug })
    } catch (parseErr) {
      console.warn(
        `[dispatch-workflow-sd-created] ${row.slug}: workflow_snapshot malformed, skipping:`,
        parseErr instanceof Error ? parseErr.message : String(parseErr),
      )
      continue
    }
    matches.push({ slug: row.slug, snapshot, raw_metadata: metadata as Record<string, unknown> })
  }

  if (matches.length === 0) return { spawned: false, reason: "no_trigger_match" }
  if (matches.length > 1) {
    const slugs = matches.map((m) => m.slug)
    console.warn(
      `[dispatch-workflow-sd-created] AMBIGUOUS trigger match for service_type='${delivery.service_type}': ${slugs.join(", ")}. ` +
        `Fix catalog data so only one workflow matches.`,
    )
    return { spawned: false, reason: "ambiguous", candidates: slugs }
  }

  const matched = matches[0]

  // ── 3. Build + validate task_meta ──────────────────────────────────────
  let taskMeta: Record<string, unknown>
  try {
    taskMeta = await build_task_meta(matched)
  } catch (err) {
    return {
      spawned: false,
      reason: "spawn_failed",
      workflow_slug: matched.slug,
      spawn_error: `build_task_meta threw: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Seed sd_stage so TaskCard's visibility_predicate filter works on first render.
  if (!("sd_stage" in taskMeta) && delivery.stage) {
    taskMeta.sd_stage = delivery.stage
  }
  // Carry the SD id so idempotency on retry catches duplicates.
  if (!("service_delivery_id" in taskMeta)) {
    taskMeta.service_delivery_id = delivery.id
  }

  const schemaName = (matched.raw_metadata.task_meta_schema as string | undefined) ?? null
  const schema = getWorkflowSchema(schemaName)
  if (schema) {
    const parsed = schema.safeParse(taskMeta)
    if (!parsed.success) {
      return {
        spawned: false,
        reason: "meta_invalid",
        workflow_slug: matched.slug,
        meta_error: parsed.error.message,
      }
    }
  }

  // ── 4. Spawn the workflow task ─────────────────────────────────────────
  const resolved = resolveTaskTextFields(
    matched.raw_metadata,
    { ...(delivery as unknown as Record<string, unknown>), ...taskMeta },
    { task_title: params.task_title, description: params.description ?? null },
    matched.slug,
  )

  const spawn = await createWorkflowTask({
    workflow_slug: matched.slug,
    workflow_snapshot: buildSnapshotForStorage({ slug: matched.slug, metadata: matched.raw_metadata }),
    task_meta: taskMeta,
    task_title: resolved.task_title,
    description: resolved.description,
    assigned_to: (matched.raw_metadata.default_assignee as string) ?? defaultTaskAssignee(),
    priority: (matched.raw_metadata.default_priority as "Urgent" | "High" | "Normal" | "Low") ?? "High",
    status: "To Do",
    account_id: delivery.account_id ?? null,
    contact_id: delivery.contact_id ?? null,
    delivery_id: delivery.id,
    actor,
    summary: `Workflow ${matched.slug} task created (sd_created trigger)`,
    details: { workflow_slug: matched.slug, service_type: delivery.service_type, service_delivery_id: delivery.id },
  })

  if (!spawn.success) {
    return {
      spawned: false,
      reason: "spawn_failed",
      workflow_slug: matched.slug,
      spawn_error: spawn.error,
    }
  }

  // Emit portal-chat topic message (red unread dot) — non-fatal.
  await emitTopicForWorkflow({
    matched,
    contact_id: delivery.contact_id ?? null,
    account_id: delivery.account_id ?? null,
    task_id: spawn.task_id,
    context: {
      service_name: delivery.service_name ?? delivery.service_type,
      service_type: delivery.service_type,
      stage: delivery.stage ?? undefined,
    },
  })

  return {
    spawned: true,
    workflow_slug: matched.slug,
    task_id: spawn.task_id,
  }
}

/**
 * Public entry point for SD-created dispatch. Runs the inner dispatcher
 * unchanged, then records one observation-only workflow_dispatch_log row. The
 * log write is timeout-bounded and never throws, so it cannot change or slow
 * the dispatch outcome the caller receives.
 */
export async function dispatchWorkflowForSdCreated(
  params: DispatchSdCreatedParams,
): Promise<DispatchResult> {
  const result = await dispatchWorkflowForSdCreatedInner(params)

  await logWorkflowDispatch({
    trigger_source: "sd_created",
    event_descriptor: params.delivery.service_type,
    event_ref: params.delivery.id,
    result,
    account_id: params.delivery.account_id ?? null,
    contact_id: params.delivery.contact_id ?? null,
    delivery_id: params.delivery.id,
    actor: params.actor,
    extra_details: { service_type: params.delivery.service_type },
  })

  return result
}

/**
 * Internal helper: emit a system-authored portal-chat message under the
 * matched workflow's auto_topic. Resolves the message body from the
 * workflow's `auto_message_template` (interpolated against the provided
 * context) with a generic fallback when not set.
 *
 * Non-fatal: any failure here is logged and swallowed — task creation must
 * not be rolled back just because the topic message couldn't be written.
 *
 * Per Antonio (2026-05-18): every client action needing staff attention
 * must produce a topic with a red badge in the portal-chats thread.
 */
async function emitTopicForWorkflow(args: {
  matched: MatchedWorkflow
  contact_id: string | null
  account_id: string | null
  task_id: string
  context: { service_name?: string; service_type?: string; stage?: string }
}): Promise<void> {
  try {
    const meta = args.matched.raw_metadata
    const autoTopic = typeof meta.auto_topic === "string" ? meta.auto_topic : null
    if (!autoTopic) return // workflow opted out of topic emit

    const template =
      typeof meta.auto_message_template === "string"
        ? (meta.auto_message_template as string)
        : `Client triggered ${args.context.service_type ?? args.matched.slug}. Review and take next step.`

    const ctx: Record<string, string> = {
      service_type: args.context.service_type ?? "",
      service_name: args.context.service_name ?? args.context.service_type ?? "",
      stage: args.context.stage ?? "—",
    }
    const message = template.replace(/\{(\w+)\}/g, (_, key) => ctx[key] ?? `{${key}}`)

    const { emitClientChatEvent } = await import("@/lib/portal/chat-events")
    const result = await emitClientChatEvent({
      contact_id: args.contact_id,
      account_id: args.account_id,
      topic: autoTopic,
      message,
      source: { table: "tasks", id: args.task_id },
      event_kind: "workflow_spawned",
    })
    if (!result.emitted && result.reason !== "already_emitted") {
      console.warn(
        `[dispatch-workflow] topic emit non-fatal failure for task ${args.task_id}: ${result.reason} ${result.error ?? ""}`,
      )
    }
  } catch (err) {
    console.warn(
      `[dispatch-workflow] topic emit threw non-fatally for task ${args.task_id}:`,
      err instanceof Error ? err.message : String(err),
    )
  }
}
