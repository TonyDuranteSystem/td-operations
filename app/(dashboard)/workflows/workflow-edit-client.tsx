"use client"

import { useState, useMemo, useEffect } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, ChevronDown, ChevronRight, ArrowUp, ArrowDown, Trash2, AlertCircle, CheckCircle2, Loader2, Plus, X } from "lucide-react"
import { toast } from "sonner"
import type { CatalogEntry } from "@/lib/catalog/framework"
import {
  getHandlerParamSchema,
  getRegisteredHandlerParamSchemaSlugs,
} from "@/lib/tasks/workflow-handler-params"
import { introspect } from "@/lib/forms/schema-introspection"
import { SchemaForm } from "@/components/forms/schema-form"
import type { CatalogValidityIssue } from "@/lib/tasks/catalog-validity"
import {
  createWorkflow,
  saveWorkflowDraft,
  publishWorkflow,
  countInFlightTasks,
} from "./actions"

interface Props {
  mode: "new" | "edit"
  initial: CatalogEntry | null
}

// ─── Draft state shape ─────────────────────────────────────────────────
//
// Mirrors the catalog row's metadata JSONB shape but treated as a free-form
// editable object. We do NOT enforce the WorkflowSnapshotSchema as a typed
// shape here — that runs at Publish time (Phase 6 will call
// validateWorkflowCatalog before writing). Letting the draft be loose-typed
// during editing means Antonio can leave a field empty mid-edit without the
// UI throwing.

type Role = "admin" | "team"
type Priority = "Urgent" | "High" | "Normal" | "Low"

interface WorkflowDraft {
  // identity (slug only editable in 'new' mode)
  slug: string
  // top-level
  label_admin: string
  icon: string
  default_assignee: string
  default_priority: Priority
  permission: { role_in: Role[] }
  attachment_template: string
  task_meta_schema: string
  auto_topic: string
  // templates
  task_title_template: string
  description_template: string
  // trigger
  triggered_by: TriggerDraft
  // SLA
  sla: SlaDraft | null
  // actions (Phase 5)
  actions: ActionDraft[]
  // pipeline stages — stored in metadata.stages[], used to drive dropdowns in action editor
  stages: string[]
}

const TASK_STATUSES = ["To Do", "In Progress", "Waiting", "Done", "Cancelled"] as const
type TaskStatus = (typeof TASK_STATUSES)[number]

interface ActionDraft {
  /** UI-only key for React list stability across reorders. Stripped before save. */
  _editorKey: string
  slug: string
  label_admin: string
  primary: boolean
  icon: string
  color: string
  handler: string
  handler_params: Record<string, unknown>
  on_success_status: TaskStatus
  /** Comma-separated stage list — converted to string | string[] at save time. */
  visible_when_sd_stage: string
}

function newActionDraft(): ActionDraft {
  return {
    _editorKey: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
    slug: "",
    label_admin: "",
    primary: false,
    icon: "",
    color: "",
    handler: "",
    handler_params: {},
    on_success_status: "Done",
    visible_when_sd_stage: "",
  }
}

function actionFromRaw(raw: Record<string, unknown>): ActionDraft {
  const visible = raw.visible_when as { sd_stage?: string | string[] } | undefined
  const sd_stage = visible?.sd_stage
  return {
    _editorKey: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
    slug: typeof raw.slug === "string" ? raw.slug : "",
    label_admin: typeof raw.label_admin === "string" ? raw.label_admin : "",
    primary: raw.primary === true,
    icon: typeof raw.icon === "string" ? raw.icon : "",
    color: typeof raw.color === "string" ? raw.color : "",
    handler: typeof raw.handler === "string" ? raw.handler : "",
    handler_params: (raw.handler_params && typeof raw.handler_params === "object"
      ? raw.handler_params
      : {}) as Record<string, unknown>,
    on_success_status:
      typeof raw.on_success_status === "string" && (TASK_STATUSES as readonly string[]).includes(raw.on_success_status)
        ? (raw.on_success_status as TaskStatus)
        : "Done",
    visible_when_sd_stage: Array.isArray(sd_stage)
      ? sd_stage.join(", ")
      : typeof sd_stage === "string"
        ? sd_stage
        : "",
  }
}

type TriggerSource = "none" | "form_submission" | "sd_created"
interface TriggerDraft {
  source: TriggerSource
  table: string
  // free-form key=value pairs for the filter map
  filter: Array<{ key: string; value: string }>
}
interface SlaDraft {
  warn_hours: number | ""
  escalate_hours: number | ""
  escalate_to: string
  auto_reassign: boolean
  notify_email_to: string
}

function blankDraft(): WorkflowDraft {
  return {
    slug: "",
    label_admin: "",
    icon: "",
    default_assignee: "",
    default_priority: "Normal",
    permission: { role_in: ["admin", "team"] },
    attachment_template: "",
    task_meta_schema: "",
    auto_topic: "",
    task_title_template: "",
    description_template: "",
    triggered_by: { source: "none", table: "", filter: [] },
    sla: null,
    actions: [],
    stages: [],
  }
}

function fromEntry(entry: CatalogEntry): WorkflowDraft {
  const m = (entry.metadata ?? {}) as Record<string, unknown>
  const trig = m.triggered_by as Record<string, unknown> | undefined
  const sla = m.sla as Record<string, unknown> | undefined
  const perm = m.permission as Record<string, unknown> | undefined
  const roleIn = (perm?.role_in as string[] | undefined) ?? ["admin", "team"]
  const filterObj = (trig?.filter as Record<string, unknown> | undefined) ?? {}

  return {
    slug: entry.slug,
    label_admin: typeof m.label_admin === "string" ? m.label_admin : "",
    icon: typeof m.icon === "string" ? m.icon : "",
    default_assignee: typeof m.default_assignee === "string" ? m.default_assignee : "",
    default_priority:
      typeof m.default_priority === "string" && ["Urgent", "High", "Normal", "Low"].includes(m.default_priority)
        ? (m.default_priority as Priority)
        : "Normal",
    permission: { role_in: roleIn.filter((r): r is Role => r === "admin" || r === "team") },
    attachment_template: typeof m.attachment_template === "string" ? m.attachment_template : "",
    task_meta_schema: typeof m.task_meta_schema === "string" ? m.task_meta_schema : "",
    auto_topic: typeof m.auto_topic === "string" ? m.auto_topic : "",
    task_title_template: typeof m.task_title_template === "string" ? m.task_title_template : "",
    description_template: typeof m.description_template === "string" ? m.description_template : "",
    triggered_by: {
      source:
        trig?.source === "form_submission" || trig?.source === "sd_created"
          ? trig.source
          : "none",
      table: typeof trig?.table === "string" ? trig.table : "",
      filter: Object.entries(filterObj).map(([key, value]) => ({
        key,
        value: typeof value === "string" ? value : JSON.stringify(value),
      })),
    },
    sla: sla
      ? {
          warn_hours: typeof sla.warn_hours === "number" ? sla.warn_hours : "",
          escalate_hours: typeof sla.escalate_hours === "number" ? sla.escalate_hours : "",
          escalate_to: typeof sla.escalate_to === "string" ? sla.escalate_to : "",
          auto_reassign: sla.auto_reassign === false ? false : true,
          notify_email_to: typeof sla.notify_email_to === "string" ? sla.notify_email_to : "",
        }
      : null,
    actions: Array.isArray(m.actions)
      ? (m.actions as Array<Record<string, unknown>>).map(actionFromRaw)
      : [],
    stages: Array.isArray(m.stages) ? (m.stages as unknown[]).filter((s): s is string => typeof s === "string") : [],
  }
}

// ─── Component ─────────────────────────────────────────────────────────

export function WorkflowEditClient({ mode, initial }: Props) {
  const router = useRouter()
  const [draft, setDraft] = useState<WorkflowDraft>(() =>
    initial ? fromEntry(initial) : blankDraft(),
  )
  // Track the current row identity + concurrency baseline. Updated after
  // every successful save so the next save uses the latest updated_at.
  const [entryId, setEntryId] = useState<string | null>(initial?.id ?? null)
  const [baselineUpdatedAt, setBaselineUpdatedAt] = useState<string | null>(
    initial?.updated_at ?? null,
  )
  const [status, setStatus] = useState<CatalogEntry["status"] | null>(
    initial?.status ?? null,
  )

  function updateDraft<K extends keyof WorkflowDraft>(key: K, value: WorkflowDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  const title =
    mode === "new"
      ? "New Workflow"
      : `Edit · ${draft.label_admin || draft.slug || "workflow"}`

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/workflows"
          className="inline-flex items-center gap-1 text-sm text-zinc-600 hover:text-zinc-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to workflows
        </Link>
      </div>
      <h1 className="text-2xl font-semibold text-zinc-900 mb-1">{title}</h1>
      {mode === "edit" && (
        <p className="text-sm text-zinc-500 mb-6 font-mono">{draft.slug}</p>
      )}

      {status && (
        <p className="text-xs mb-4">
          Status: <StatusPill status={status} />
        </p>
      )}

      <TopLevelSection mode={mode} draft={draft} updateDraft={updateDraft} />
      <TriggerSection draft={draft} updateDraft={updateDraft} />
      {draft.triggered_by.source === "sd_created" && (
        <PipelineStagesSection draft={draft} updateDraft={updateDraft} />
      )}
      <SlaSection draft={draft} updateDraft={updateDraft} />
      <TemplatesSection draft={draft} updateDraft={updateDraft} />
      <ActionsSection draft={draft} updateDraft={updateDraft} stages={draft.stages} />

      <SaveSection
        mode={mode}
        draft={draft}
        entryId={entryId}
        baselineUpdatedAt={baselineUpdatedAt}
        onSavedDraft={(e) => {
          setEntryId(e.id)
          setBaselineUpdatedAt(e.updated_at)
          setStatus(e.status)
          if (mode === "new") {
            router.replace(`/workflows/${e.slug}`)
          }
        }}
        onPublished={(e) => {
          setEntryId(e.id)
          setBaselineUpdatedAt(e.updated_at)
          setStatus(e.status)
        }}
      />
    </div>
  )
}

function StatusPill({ status }: { status: CatalogEntry["status"] }) {
  const cls =
    status === "active"
      ? "bg-green-100 text-green-800"
      : status === "draft"
        ? "bg-blue-100 text-blue-800"
        : status === "deprecated"
          ? "bg-zinc-200 text-zinc-600"
          : "bg-amber-100 text-amber-800"
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded font-medium ${cls}`}>{status}</span>
  )
}

// ─── Sections ──────────────────────────────────────────────────────────

type UpdateFn = <K extends keyof WorkflowDraft>(key: K, value: WorkflowDraft[K]) => void

function Card({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-4 bg-white border rounded-lg">
      <header className="px-4 py-3 border-b bg-zinc-50">
        <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
        {description && <p className="text-xs text-zinc-500 mt-0.5">{description}</p>}
      </header>
      <div className="p-4 space-y-3">{children}</div>
    </section>
  )
}

function Field({
  label,
  required,
  children,
  hint,
}: {
  label: string
  required?: boolean
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-zinc-800 mb-1">
        {label}
        {required && <span className="ml-0.5 text-red-600">*</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-zinc-500">{hint}</p>}
    </div>
  )
}

const inputClass =
  "w-full px-3 py-2 text-sm border border-zinc-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"

// ── Top-level section ──────────────────────────────────────────────────

function TopLevelSection({
  mode,
  draft,
  updateDraft,
}: {
  mode: "new" | "edit"
  draft: WorkflowDraft
  updateDraft: UpdateFn
}) {
  return (
    <Card
      title="Basics"
      description="Identifies the workflow + default behavior for spawned tasks."
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Slug" required hint="Permanent identifier — lowercase, underscores. Cannot change after publish.">
          <input
            type="text"
            value={draft.slug}
            disabled={mode === "edit"}
            onChange={(e) => updateDraft("slug", e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
            className={`${inputClass} ${mode === "edit" ? "bg-zinc-50 text-zinc-500" : ""}`}
            placeholder="e.g. ein_change_name"
          />
        </Field>
        <Field label="Label (admin)" required hint="Shown in TaskCard header and CRM lists.">
          <input
            type="text"
            value={draft.label_admin}
            onChange={(e) => updateDraft("label_admin", e.target.value)}
            className={inputClass}
            placeholder="EIN Change of Name"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Icon" hint="Lucide icon name (Building2, FileCheck, etc.). Optional.">
          <input
            type="text"
            value={draft.icon}
            onChange={(e) => updateDraft("icon", e.target.value)}
            className={inputClass}
            placeholder="FileText"
          />
        </Field>
        <Field label="Default assignee" hint="Falls back to DEFAULT_TASK_ASSIGNEE env (today: Luca).">
          <input
            type="text"
            value={draft.default_assignee}
            onChange={(e) => updateDraft("default_assignee", e.target.value)}
            className={inputClass}
            placeholder="Luca"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Default priority">
          <select
            value={draft.default_priority}
            onChange={(e) => updateDraft("default_priority", e.target.value as Priority)}
            className={inputClass}
          >
            {(["Urgent", "High", "Normal", "Low"] as const).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Allowed roles" required hint="Which CRM roles can see + run actions on the task.">
          <div className="flex gap-3 items-center pt-1">
            {(["admin", "team"] as const).map((role) => {
              const checked = draft.permission.role_in.includes(role)
              return (
                <label key={role} className="inline-flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? Array.from(new Set([...draft.permission.role_in, role]))
                        : draft.permission.role_in.filter((r) => r !== role)
                      updateDraft("permission", { role_in: next })
                    }}
                  />
                  {role}
                </label>
              )
            })}
          </div>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="task_meta schema" hint="Name of registered Zod schema in lib/tasks/workflow-schemas.ts. Blank = no validation.">
          <input
            type="text"
            value={draft.task_meta_schema}
            onChange={(e) => updateDraft("task_meta_schema", e.target.value)}
            className={inputClass}
            placeholder="itin_review_v1"
          />
        </Field>
        <Field label="Attachment template" hint="Name of registered React component in components/tasks/attachment-templates.">
          <input
            type="text"
            value={draft.attachment_template}
            onChange={(e) => updateDraft("attachment_template", e.target.value)}
            className={inputClass}
            placeholder="pdf_list"
          />
        </Field>
      </div>
      <Field label="Auto-topic (chat label)" hint="When set, chat messages for this task auto-group under this topic.">
        <input
          type="text"
          value={draft.auto_topic}
          onChange={(e) => updateDraft("auto_topic", e.target.value)}
          className={inputClass}
          placeholder="ITIN"
        />
      </Field>
    </Card>
  )
}

// ── Trigger section ────────────────────────────────────────────────────

function TriggerSection({ draft, updateDraft }: { draft: WorkflowDraft; updateDraft: UpdateFn }) {
  const t = draft.triggered_by
  function patch(p: Partial<TriggerDraft>) {
    updateDraft("triggered_by", { ...t, ...p })
  }
  function setFilter(idx: number, key: string, value: string) {
    const next = [...t.filter]
    next[idx] = { key, value }
    patch({ filter: next })
  }
  function addFilter() {
    patch({ filter: [...t.filter, { key: "", value: "" }] })
  }
  function removeFilter(idx: number) {
    patch({ filter: t.filter.filter((_, i) => i !== idx) })
  }

  return (
    <Card
      title="Trigger"
      description="What event spawns a task for this workflow. None = chain-spawned only."
    >
      <Field label="Source">
        <select
          value={t.source}
          onChange={(e) => {
            const next = e.target.value as TriggerSource
            // Reset table when switching away from form_submission so a stale
            // value can't leak into the saved metadata.
            patch({ source: next, table: next === "form_submission" ? t.table : "" })
          }}
          className={inputClass}
        >
          <option value="none">none (chain-spawned only)</option>
          <option value="form_submission">form_submission (a client form completes)</option>
          <option value="sd_created">sd_created (a service delivery is created)</option>
        </select>
      </Field>

      {t.source === "form_submission" && (
        <Field label="Submissions table" required hint="DB table name (e.g. banking_submissions, itin_submissions, tax_return_submissions).">
          <input
            type="text"
            value={t.table}
            onChange={(e) => patch({ table: e.target.value })}
            className={inputClass}
            placeholder="banking_submissions"
          />
        </Field>
      )}

      {(t.source === "form_submission" || t.source === "sd_created") && (
        <Field
          label="Filter"
          hint={
            t.source === "sd_created"
              ? "At minimum: service_type=YourServiceType"
              : "Match submission columns, e.g. provider=mercury"
          }
        >
          <div className="space-y-1">
            {t.filter.length === 0 && (
              <p className="text-[11px] text-zinc-400 italic">No filter — matches any event of this source.</p>
            )}
            {t.filter.map((f, i) => (
              <div key={i} className="flex gap-2">
                <input
                  type="text"
                  value={f.key}
                  onChange={(e) => setFilter(i, e.target.value, f.value)}
                  placeholder="key"
                  className={inputClass}
                />
                <input
                  type="text"
                  value={f.value}
                  onChange={(e) => setFilter(i, f.key, e.target.value)}
                  placeholder="value"
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => removeFilter(i)}
                  className="px-2 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addFilter}
              className="mt-1 px-2 py-1 text-xs border border-zinc-300 rounded hover:bg-zinc-50"
            >
              + Add filter
            </button>
          </div>
        </Field>
      )}
    </Card>
  )
}

// ── SLA section (collapsible) ──────────────────────────────────────────

function SlaSection({ draft, updateDraft }: { draft: WorkflowDraft; updateDraft: UpdateFn }) {
  const [open, setOpen] = useState(draft.sla !== null)
  const enabled = draft.sla !== null

  function toggleEnabled(next: boolean) {
    if (next) {
      updateDraft("sla", {
        warn_hours: "",
        escalate_hours: "",
        escalate_to: "Antonio",
        auto_reassign: true,
        notify_email_to: "",
      })
      setOpen(true)
    } else {
      updateDraft("sla", null)
      setOpen(false)
    }
  }

  function patch(p: Partial<SlaDraft>) {
    if (!draft.sla) return
    updateDraft("sla", { ...draft.sla, ...p })
  }

  return (
    <section className="mb-4 bg-white border rounded-lg">
      <header className="px-4 py-3 border-b bg-zinc-50 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center"
            >
              {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            SLA
          </h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            When set, the hourly SLA cron flags overdue tasks and (optionally) reassigns + emails.
          </p>
        </div>
        <label className="inline-flex items-center gap-2 text-xs font-medium">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => toggleEnabled(e.target.checked)}
          />
          Enable SLA
        </label>
      </header>
      {open && enabled && draft.sla && (
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Warn after (hours)" hint="Yellow badge appears.">
              <input
                type="number"
                value={draft.sla.warn_hours}
                onChange={(e) =>
                  patch({ warn_hours: e.target.value === "" ? "" : parseFloat(e.target.value) })
                }
                className={inputClass}
                placeholder="24"
              />
            </Field>
            <Field label="Escalate after (hours)" hint="Red badge + (optional) reassign + email.">
              <input
                type="number"
                value={draft.sla.escalate_hours}
                onChange={(e) =>
                  patch({ escalate_hours: e.target.value === "" ? "" : parseFloat(e.target.value) })
                }
                className={inputClass}
                placeholder="72"
              />
            </Field>
          </div>
          <Field label="Escalate to (assignee)" hint="Used by auto-reassign and shown in escalation email.">
            <input
              type="text"
              value={draft.sla.escalate_to}
              onChange={(e) => patch({ escalate_to: e.target.value })}
              className={inputClass}
              placeholder="Antonio"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Auto-reassign on escalate?">
              <label className="inline-flex items-center gap-2 text-sm pt-1">
                <input
                  type="checkbox"
                  checked={draft.sla.auto_reassign}
                  onChange={(e) => patch({ auto_reassign: e.target.checked })}
                />
                {draft.sla.auto_reassign ? "yes — task moves to escalate-to" : "no — keep original"}
              </label>
            </Field>
            <Field
              label="Notify email"
              hint="Default: support@tonydurante.us. Empty = suppress email."
            >
              <input
                type="text"
                value={draft.sla.notify_email_to}
                onChange={(e) => patch({ notify_email_to: e.target.value })}
                className={inputClass}
                placeholder="(default: support@tonydurante.us)"
              />
            </Field>
          </div>
        </div>
      )}
    </section>
  )
}

// ── Templates section ──────────────────────────────────────────────────

function TemplatesSection({
  draft,
  updateDraft,
}: {
  draft: WorkflowDraft
  updateDraft: UpdateFn
}) {
  // Available interpolation tokens depend on the trigger source.
  // Form-submission triggers: submission columns are workflow-specific (we
  // surface common ones); sd_created has a fixed shape.
  const tokens =
    draft.triggered_by.source === "sd_created"
      ? ["service_type", "service_name", "account_id", "contact_id", "sd_stage", "service_delivery_id"]
      : draft.triggered_by.source === "form_submission"
        ? ["company_name", "submission_id", "account_id", "contact_id", "token"]
        : []

  return (
    <Card
      title="Templates"
      description='Use {token} placeholders. Available tokens are shown below based on the trigger source. Missing tokens fall back to caller-supplied literal at runtime + warn log.'
    >
      {tokens.length > 0 && (
        <div className="flex flex-wrap gap-1 text-[11px]">
          <span className="text-zinc-500">Tokens:</span>
          {tokens.map((tk) => (
            <code key={tk} className="px-1.5 py-0.5 bg-zinc-100 rounded font-mono text-zinc-700">
              {`{${tk}}`}
            </code>
          ))}
        </div>
      )}
      <Field
        label="task_title template"
        hint="Example: Review Mercury banking form — {company_name}"
      >
        <input
          type="text"
          value={draft.task_title_template}
          onChange={(e) => updateDraft("task_title_template", e.target.value)}
          className={inputClass}
          placeholder="{service_type} — {service_name}"
        />
      </Field>
      <Field
        label="Description template"
        hint="Free-form. Empty = no description on spawned task."
      >
        <textarea
          value={draft.description_template}
          rows={3}
          onChange={(e) => updateDraft("description_template", e.target.value)}
          className={inputClass}
        />
      </Field>
    </Card>
  )
}

// ── Pipeline stages section ────────────────────────────────────────────

function PipelineStagesSection({ draft, updateDraft }: { draft: WorkflowDraft; updateDraft: UpdateFn }) {
  const [newStage, setNewStage] = useState("")

  function addStage() {
    const trimmed = newStage.trim()
    if (!trimmed || draft.stages.includes(trimmed)) return
    updateDraft("stages", [...draft.stages, trimmed])
    setNewStage("")
  }

  function removeStage(idx: number) {
    updateDraft("stages", draft.stages.filter((_, i) => i !== idx))
  }

  function moveStage(idx: number, dir: -1 | 1) {
    const j = idx + dir
    if (j < 0 || j >= draft.stages.length) return
    const next = [...draft.stages]
    ;[next[idx], next[j]] = [next[j], next[idx]]
    updateDraft("stages", next)
  }

  function generateActions() {
    const stages = draft.stages
    if (stages.length < 2) return
    if (draft.actions.length > 0 && !confirm("This will replace all current actions. Continue?")) return
    const generated: ActionDraft[] = []
    for (let i = 0; i < stages.length - 1; i++) {
      const from = stages[i]
      const to = stages[i + 1]
      const toSlug = to.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/, "")
      generated.push({
        _editorKey: crypto.randomUUID(),
        slug: `advance_to_${toSlug}`,
        label_admin: `${from} → ${to}`,
        primary: i === 0,
        icon: i === stages.length - 2 ? "CheckCircle2" : "ArrowRight",
        color: i === stages.length - 2 ? "green" : "blue",
        handler: "chain.advance_sd_stage",
        handler_params: { target_stage: to },
        on_success_status: "In Progress",
        visible_when_sd_stage: from,
      })
    }
    generated.push({
      _editorKey: crypto.randomUUID(),
      slug: "mark_complete",
      label_admin: "Mark Complete",
      primary: false,
      icon: "PartyPopper",
      color: "green",
      handler: "sd.mark_complete",
      handler_params: {},
      on_success_status: "Done",
      visible_when_sd_stage: stages[stages.length - 1],
    })
    generated.push({
      _editorKey: crypto.randomUUID(),
      slug: "needs_fix",
      label_admin: "Blocked / Needs Info",
      primary: false,
      icon: "AlertCircle",
      color: "amber",
      handler: "task.flag_blocked",
      handler_params: {},
      on_success_status: "Waiting",
      visible_when_sd_stage: "",
    })
    updateDraft("actions", generated)
  }

  return (
    <Card
      title="Pipeline Stages"
      description="Define the SD stages for this workflow. These drive the Visible when and Target Stage dropdowns in action buttons."
    >
      {draft.stages.length === 0 && (
        <p className="text-sm text-zinc-500 italic">No stages yet. Add the first stage below.</p>
      )}
      <div className="space-y-1">
        {draft.stages.map((stage, idx) => (
          <div key={idx} className="flex items-center gap-2 p-2 bg-zinc-50 rounded border border-zinc-200">
            <span className="text-xs text-zinc-400 w-5 text-right font-mono">{idx + 1}</span>
            <span className="flex-1 text-sm font-medium text-zinc-800">{stage}</span>
            <button
              type="button"
              onClick={() => moveStage(idx, -1)}
              disabled={idx === 0}
              className="p-1 rounded hover:bg-zinc-200 disabled:opacity-30"
              title="Move up"
            >
              <ArrowUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => moveStage(idx, 1)}
              disabled={idx === draft.stages.length - 1}
              className="p-1 rounded hover:bg-zinc-200 disabled:opacity-30"
              title="Move down"
            >
              <ArrowDown className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => removeStage(idx)}
              className="p-1 rounded text-red-500 hover:bg-red-50"
              title="Remove stage"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2 mt-2">
        <input
          type="text"
          value={newStage}
          onChange={(e) => setNewStage(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addStage() } }}
          placeholder="e.g. File the form 8822-B"
          className={`${inputClass} flex-1`}
        />
        <button
          type="button"
          onClick={addStage}
          disabled={!newStage.trim()}
          className="px-3 py-2 text-sm bg-zinc-800 text-white rounded-md hover:bg-zinc-700 disabled:opacity-40 inline-flex items-center gap-1"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </button>
      </div>
      {draft.stages.length >= 2 && (
        <div className="mt-3 pt-3 border-t border-zinc-200">
          <button
            type="button"
            onClick={generateActions}
            className="w-full px-3 py-2 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 font-medium"
          >
            ✦ Auto-generate action buttons from these {draft.stages.length} stages
          </button>
          <p className="mt-1 text-[11px] text-zinc-500">
            Creates one transition button per stage, a Mark Complete on the last, and a Blocked action. Scroll to Actions to review.
          </p>
        </div>
      )}
    </Card>
  )
}

// ── Actions section ────────────────────────────────────────────────────

function ActionsSection({
  draft,
  updateDraft,
  stages,
}: {
  draft: WorkflowDraft
  updateDraft: UpdateFn
  stages: string[]
}) {
  const handlerSlugs = useMemo(() => getRegisteredHandlerParamSchemaSlugs().sort(), [])

  function updateAction(idx: number, patch: Partial<ActionDraft>) {
    const next = [...draft.actions]
    next[idx] = { ...next[idx], ...patch }
    updateDraft("actions", next)
  }

  function move(idx: number, dir: -1 | 1) {
    const j = idx + dir
    if (j < 0 || j >= draft.actions.length) return
    const next = [...draft.actions]
    const tmp = next[idx]
    next[idx] = next[j]
    next[j] = tmp
    updateDraft("actions", next)
  }

  function remove(idx: number) {
    if (!confirm(`Remove action "${draft.actions[idx].label_admin || draft.actions[idx].slug || "(unnamed)"}"?`)) return
    updateDraft("actions", draft.actions.filter((_, i) => i !== idx))
  }

  function add() {
    updateDraft("actions", [...draft.actions, newActionDraft()])
  }

  function generateFromStages() {
    if (stages.length < 2) return
    if (draft.actions.length > 0 && !confirm("This will replace all current actions. Continue?")) return
    const generated: ActionDraft[] = []
    for (let i = 0; i < stages.length - 1; i++) {
      const from = stages[i]
      const to = stages[i + 1]
      const toSlug = to.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/, "")
      generated.push({
        _editorKey: crypto.randomUUID(),
        slug: `advance_to_${toSlug}`,
        label_admin: `${from} → ${to}`,
        primary: i === 0,
        icon: i === stages.length - 2 ? "CheckCircle2" : "ArrowRight",
        color: i === stages.length - 2 ? "green" : "blue",
        handler: "chain.advance_sd_stage",
        handler_params: { target_stage: to },
        on_success_status: "In Progress",
        visible_when_sd_stage: from,
      })
    }
    // Mark complete on last stage
    generated.push({
      _editorKey: crypto.randomUUID(),
      slug: "mark_complete",
      label_admin: "Mark Complete",
      primary: false,
      icon: "PartyPopper",
      color: "green",
      handler: "sd.mark_complete",
      handler_params: {},
      on_success_status: "Done",
      visible_when_sd_stage: stages[stages.length - 1],
    })
    // Always-visible blocked action
    generated.push({
      _editorKey: crypto.randomUUID(),
      slug: "needs_fix",
      label_admin: "Blocked / Needs Info",
      primary: false,
      icon: "AlertCircle",
      color: "amber",
      handler: "task.flag_blocked",
      handler_params: {},
      on_success_status: "Waiting",
      visible_when_sd_stage: "",
    })
    updateDraft("actions", generated)
  }

  return (
    <Card
      title="Actions"
      description="Each action is a button on the spawned task. Order matters — first action is shown as the primary button when marked primary."
    >
      {draft.actions.length === 0 && (
        <p className="text-sm text-zinc-500 italic">
          No actions yet.{stages.length >= 2 ? " Use \"Auto-generate\" to create one action per stage transition, or click + Add Action." : " Click + Add Action to create the first step."}
        </p>
      )}
      {draft.actions.map((action, idx) => (
        <ActionCard
          key={action._editorKey}
          idx={idx}
          total={draft.actions.length}
          action={action}
          handlerSlugs={handlerSlugs}
          stages={stages}
          onPatch={(patch) => updateAction(idx, patch)}
          onMove={(dir) => move(idx, dir)}
          onRemove={() => remove(idx)}
        />
      ))}
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <button
          type="button"
          onClick={add}
          className="px-3 py-1.5 text-sm border border-blue-300 text-blue-700 rounded-md hover:bg-blue-50"
        >
          + Add Action
        </button>
        {stages.length >= 2 && (
          <button
            type="button"
            onClick={generateFromStages}
            className="px-3 py-1.5 text-sm border border-green-300 text-green-700 rounded-md hover:bg-green-50"
            title={`Auto-create ${stages.length - 1} transition actions + mark complete + blocked`}
          >
            ✦ Auto-generate from stages
          </button>
        )}
      </div>
    </Card>
  )
}

function ActionCard({
  idx,
  total,
  action,
  handlerSlugs,
  stages,
  onPatch,
  onMove,
  onRemove,
}: {
  idx: number
  total: number
  action: ActionDraft
  handlerSlugs: string[]
  stages: string[]
  onPatch: (patch: Partial<ActionDraft>) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  // Introspect the chosen handler's param schema. When no handler picked yet,
  // skip rendering the params block.
  const paramsSpec = useMemo(() => {
    if (!action.handler) return null
    const schema = getHandlerParamSchema(action.handler)
    if (!schema) return null
    return introspect(schema, { label: "handler_params" })
  }, [action.handler])

  function chooseHandler(newSlug: string) {
    if (newSlug === action.handler) return
    // Reset params on handler change — new handler has a different schema,
    // and the old params almost certainly don't fit (would fail the validity
    // gate at Publish time anyway).
    onPatch({ handler: newSlug, handler_params: {} })
  }

  return (
    <div className="border border-zinc-200 rounded-md p-3 mb-2 bg-zinc-50/30">
      <header className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-zinc-600">
          Step {idx + 1} of {total}
          {action.primary && (
            <span className="ml-2 px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">primary</span>
          )}
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={idx === 0}
            className="p-1 rounded hover:bg-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Move up"
            title="Move up"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={idx === total - 1}
            className="p-1 rounded hover:bg-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Move down"
            title="Move down"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="p-1 rounded text-red-600 hover:bg-red-50"
            aria-label="Remove action"
            title="Remove action"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Slug" required hint="lowercase_with_underscores. Stable identifier for this step.">
          <input
            type="text"
            value={action.slug}
            onChange={(e) => onPatch({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
            className={inputClass}
            placeholder="approve_and_apply"
          />
        </Field>
        <Field label="Label (admin)" required hint="Button text the operator sees.">
          <input
            type="text"
            value={action.label_admin}
            onChange={(e) => onPatch({ label_admin: e.target.value })}
            className={inputClass}
            placeholder="Approve & Apply"
          />
        </Field>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Field label="Icon" hint="Lucide icon name. Optional.">
          <input
            type="text"
            value={action.icon}
            onChange={(e) => onPatch({ icon: e.target.value })}
            className={inputClass}
            placeholder="Check"
          />
        </Field>
        <Field label="Color" hint="blue / green / amber / red. Optional.">
          <input
            type="text"
            value={action.color}
            onChange={(e) => onPatch({ color: e.target.value })}
            className={inputClass}
            placeholder="blue"
          />
        </Field>
        <Field label="Primary?">
          <label className="inline-flex items-center gap-2 text-sm pt-1">
            <input
              type="checkbox"
              checked={action.primary}
              onChange={(e) => onPatch({ primary: e.target.checked })}
            />
            Render as primary button
          </label>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Handler" required hint="What this button does. Pick from registered handlers.">
          <select
            value={action.handler}
            onChange={(e) => chooseHandler(e.target.value)}
            className={inputClass}
          >
            <option value="">— Choose handler —</option>
            {handlerSlugs.map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
          </select>
        </Field>
        <Field label="On success → status" required>
          <select
            value={action.on_success_status}
            onChange={(e) => onPatch({ on_success_status: e.target.value as TaskStatus })}
            className={inputClass}
          >
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field
        label="Visible when (SD stage)"
        hint={stages.length > 0 ? "Click stages to toggle. Leave none selected = always visible." : 'Stage-aware buttons. Comma-separated for "any of". Leave empty for always visible.'}
      >
        {stages.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 mt-1">
            {stages.map((stage) => {
              const active = action.visible_when_sd_stage
                .split(",")
                .map((s) => s.trim())
                .includes(stage)
              return (
                <button
                  key={stage}
                  type="button"
                  onClick={() => {
                    const current = action.visible_when_sd_stage
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean)
                    const next = active
                      ? current.filter((s) => s !== stage)
                      : [...current, stage]
                    onPatch({ visible_when_sd_stage: next.join(", ") })
                  }}
                  className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                    active
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white text-zinc-600 border-zinc-300 hover:border-blue-400"
                  }`}
                >
                  {stage}
                </button>
              )
            })}
            {action.visible_when_sd_stage === "" && (
              <span className="text-[11px] text-zinc-400 italic self-center">always visible</span>
            )}
          </div>
        ) : (
          <input
            type="text"
            value={action.visible_when_sd_stage}
            onChange={(e) => onPatch({ visible_when_sd_stage: e.target.value })}
            className={inputClass}
            placeholder="EIN Application, State Filing"
          />
        )}
      </Field>

      {/* Handler params block — schema-driven, with stage-aware overrides */}
      {action.handler && (
        <div className="mt-3 pt-3 border-t border-zinc-200">
          <p className="text-xs font-semibold text-zinc-700 mb-2">handler_params</p>
          {action.handler === "chain.advance_sd_stage" && stages.length > 0 ? (
            <Field label="Target Stage" required hint="The SD stage to advance to when this action fires.">
              <select
                value={typeof action.handler_params.target_stage === "string" ? action.handler_params.target_stage : ""}
                onChange={(e) => onPatch({ handler_params: { ...action.handler_params, target_stage: e.target.value } })}
                className={inputClass}
              >
                <option value="">— Choose target stage —</option>
                {stages.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </Field>
          ) : paramsSpec ? (
            paramsSpec.kind === "object" && Object.keys(paramsSpec.fields).length === 0 ? (
              <p className="text-[11px] text-zinc-500 italic">
                This handler takes no catalog params (input comes from operator at action time).
              </p>
            ) : (
              <SchemaForm
                spec={paramsSpec}
                value={action.handler_params}
                onChange={(next) => onPatch({ handler_params: (next ?? {}) as Record<string, unknown> })}
                bare
              />
            )
          ) : (
            <p className="text-[11px] text-amber-700">
              No schema registered for handler &apos;{action.handler}&apos; — params will be saved as-is.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Save / Publish section ─────────────────────────────────────────────

/**
 * Convert the loose UI draft into the catalog metadata shape (the JSONB
 * value written to catalog_entries.metadata). Strips UI-only fields
 * (_editorKey, the visible_when_sd_stage string form) and re-canonicalizes
 * trigger filter pairs back into an object.
 */
function draftToMetadata(draft: WorkflowDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {
    version: 1,
    label_admin: draft.label_admin,
    permission: { role_in: draft.permission.role_in },
    actions: draft.actions.map(actionToRaw),
  }
  // Optional top-level fields — include only when set so the metadata stays
  // tidy and the validity gate's "unknown field" semantics don't kick in.
  if (draft.icon) out.icon = draft.icon
  if (draft.default_assignee) out.default_assignee = draft.default_assignee
  if (draft.default_priority) out.default_priority = draft.default_priority
  if (draft.attachment_template) out.attachment_template = draft.attachment_template
  if (draft.task_meta_schema) out.task_meta_schema = draft.task_meta_schema
  if (draft.auto_topic) out.auto_topic = draft.auto_topic
  if (draft.task_title_template) out.task_title_template = draft.task_title_template
  if (draft.description_template) out.description_template = draft.description_template
  if (draft.stages.length > 0) out.stages = draft.stages

  // Trigger
  if (draft.triggered_by.source === "form_submission") {
    const filter: Record<string, string> = {}
    for (const { key, value } of draft.triggered_by.filter) {
      if (key.trim()) filter[key.trim()] = value
    }
    out.triggered_by = {
      source: "form_submission",
      table: draft.triggered_by.table,
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    }
  } else if (draft.triggered_by.source === "sd_created") {
    const filter: Record<string, string> = {}
    for (const { key, value } of draft.triggered_by.filter) {
      if (key.trim()) filter[key.trim()] = value
    }
    out.triggered_by = {
      source: "sd_created",
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    }
  }
  // source='none' → omit triggered_by entirely (workflow is chain-spawned).

  // SLA
  if (draft.sla) {
    const sla: Record<string, unknown> = {}
    if (typeof draft.sla.warn_hours === "number") sla.warn_hours = draft.sla.warn_hours
    if (typeof draft.sla.escalate_hours === "number") sla.escalate_hours = draft.sla.escalate_hours
    if (draft.sla.escalate_to) sla.escalate_to = draft.sla.escalate_to
    if (draft.sla.auto_reassign === false) sla.auto_reassign = false
    if (draft.sla.notify_email_to) sla.notify_email_to = draft.sla.notify_email_to
    if (Object.keys(sla).length > 0) out.sla = sla
  }

  return out
}

function actionToRaw(action: ActionDraft): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    slug: action.slug,
    label_admin: action.label_admin,
    handler: action.handler,
    on_success_status: action.on_success_status,
    permission: { role_in: ["admin", "team"] }, // editor doesn't expose per-action permission yet; default permissive
  }
  if (action.primary) raw.primary = true
  if (action.icon) raw.icon = action.icon
  if (action.color) raw.color = action.color
  if (action.handler_params && Object.keys(action.handler_params).length > 0) {
    raw.handler_params = action.handler_params
  }
  // visible_when.sd_stage from CSV → string | string[]
  const stages = action.visible_when_sd_stage
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (stages.length === 1) {
    raw.visible_when = { sd_stage: stages[0] }
  } else if (stages.length > 1) {
    raw.visible_when = { sd_stage: stages }
  }
  return raw
}

function SaveSection({
  mode,
  draft,
  entryId,
  baselineUpdatedAt,
  onSavedDraft,
  onPublished,
}: {
  mode: "new" | "edit"
  draft: WorkflowDraft
  entryId: string | null
  baselineUpdatedAt: string | null
  onSavedDraft: (entry: CatalogEntry) => void
  onPublished: (entry: CatalogEntry) => void
}) {
  const [saving, setSaving] = useState<"draft" | "publish" | null>(null)
  const [issues, setIssues] = useState<CatalogValidityIssue[]>([])
  const [inFlight, setInFlight] = useState<number | null>(null)

  // Pre-load in-flight task count for edits (informs the Publish warning).
  useEffect(() => {
    if (mode !== "edit" || !draft.slug) return
    let cancelled = false
    countInFlightTasks(draft.slug)
      .then((n) => {
        if (!cancelled) setInFlight(n)
      })
      .catch(() => {
        if (!cancelled) setInFlight(null)
      })
    return () => {
      cancelled = true
    }
  }, [mode, draft.slug])

  async function handleSaveDraft() {
    if (!draft.slug || !draft.label_admin) {
      toast.error("Slug and label_admin are required even for a draft.")
      return
    }
    setSaving("draft")
    setIssues([])
    try {
      const metadata = draftToMetadata(draft)
      const result =
        mode === "new" || !entryId
          ? await createWorkflow(draft.slug, metadata)
          : await saveWorkflowDraft(entryId, metadata, baselineUpdatedAt ?? "")
      if (!result.ok || !result.entry) {
        toast.error(result.error ?? "Save failed.")
      } else {
        toast.success(mode === "new" ? "Draft created." : "Draft saved.")
        onSavedDraft(result.entry)
      }
    } finally {
      setSaving(null)
    }
  }

  async function handlePublish() {
    if (mode === "new" || !entryId) {
      toast.error("Save Draft first, then Publish.")
      return
    }
    if (
      inFlight !== null &&
      inFlight > 0 &&
      !confirm(
        `${inFlight} active task${inFlight === 1 ? "" : "s"} exist for this workflow. They keep their pinned snapshot — only NEW tasks use your edits. Publish anyway?`,
      )
    ) {
      return
    }
    setSaving("publish")
    setIssues([])
    try {
      const metadata = draftToMetadata(draft)
      const result = await publishWorkflow(entryId, metadata, baselineUpdatedAt ?? "")
      if (!result.ok || !result.entry) {
        if (result.validityIssues && result.validityIssues.length > 0) {
          setIssues(result.validityIssues)
          toast.error("Validation failed — see issues below.")
        } else {
          toast.error(result.error ?? "Publish failed.")
        }
      } else {
        toast.success("Workflow published.")
        onPublished(result.entry)
      }
    } finally {
      setSaving(null)
    }
  }

  return (
    <section className="mt-6 mb-12 bg-white border rounded-lg p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-zinc-500">
          {mode === "edit" && inFlight !== null && (
            <span>
              {inFlight === 0
                ? "No active tasks for this workflow."
                : `${inFlight} active task${inFlight === 1 ? "" : "s"} (they keep their pinned snapshot on Publish).`}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={saving !== null}
            className="px-3 py-1.5 text-sm border border-zinc-300 rounded hover:bg-zinc-50 disabled:opacity-50"
          >
            {saving === "draft" ? (
              <>
                <Loader2 className="inline h-3.5 w-3.5 animate-spin mr-1" /> Saving…
              </>
            ) : (
              "Save Draft"
            )}
          </button>
          <button
            type="button"
            onClick={handlePublish}
            disabled={saving !== null || mode === "new" || !entryId}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            title={mode === "new" ? "Save Draft first, then Publish becomes available." : undefined}
          >
            {saving === "publish" ? (
              <>
                <Loader2 className="inline h-3.5 w-3.5 animate-spin mr-1" /> Publishing…
              </>
            ) : (
              <>
                <CheckCircle2 className="inline h-3.5 w-3.5 mr-1" /> Publish
              </>
            )}
          </button>
        </div>
      </div>
      {issues.length > 0 && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded">
          <p className="text-sm font-medium text-red-800 mb-2 flex items-center gap-1">
            <AlertCircle className="h-4 w-4" />
            Validation issues — fix and try again
          </p>
          <ul className="space-y-1 text-xs text-red-700">
            {issues.map((issue, i) => (
              <li key={i}>
                <span className="font-mono">[{issue.kind}]</span> {issue.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
