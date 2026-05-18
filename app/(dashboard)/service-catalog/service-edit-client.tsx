"use client"

import { useState, useMemo } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, ArrowUp, ArrowDown, Trash2, Loader2, CheckCircle2, AlertCircle, ChevronDown, ChevronRight } from "lucide-react"
import { toast } from "sonner"
import type { StageRow } from "@/lib/services/stages"
import {
  saveServiceComplete,
  type ServiceBasicsDraft,
  type ServiceDraft,
  type ServiceWorkflowDraft,
} from "./actions"
import {
  getHandlerParamSchema,
  getRegisteredHandlerParamSchemaSlugs,
} from "@/lib/tasks/workflow-handler-params"
import { introspect } from "@/lib/forms/schema-introspection"
import { SchemaForm } from "@/components/forms/schema-form"
import type { CatalogValidityIssue } from "@/lib/tasks/catalog-validity"

interface Props {
  mode: "new" | "edit"
  initial: {
    basics: ServiceBasicsDraft
    stages: StageRow[]
    workflow: {
      id: string
      slug: string
      status: string
      updated_at: string | null
      metadata: Record<string, unknown>
    } | null
  } | null
}

// ── Action draft (mirrors /workflows editor; extract later) ────────────

const TASK_STATUSES = ["To Do", "In Progress", "Waiting", "Done", "Cancelled"] as const
type TaskStatus = (typeof TASK_STATUSES)[number]
const PRIORITIES = ["Urgent", "High", "Normal", "Low"] as const
type Priority = (typeof PRIORITIES)[number]

interface ActionDraft {
  _editorKey: string
  slug: string
  label_admin: string
  primary: boolean
  icon: string
  color: string
  handler: string
  handler_params: Record<string, unknown>
  on_success_status: TaskStatus
  visible_when_sd_stage: string
}

function uniqueKey(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)
}

function newAction(): ActionDraft {
  return {
    _editorKey: uniqueKey(),
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
    _editorKey: uniqueKey(),
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

function actionToRaw(action: ActionDraft): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    slug: action.slug,
    label_admin: action.label_admin,
    handler: action.handler,
    on_success_status: action.on_success_status,
    permission: { role_in: ["admin", "team"] },
  }
  if (action.primary) raw.primary = true
  if (action.icon) raw.icon = action.icon
  if (action.color) raw.color = action.color
  if (action.handler_params && Object.keys(action.handler_params).length > 0) {
    raw.handler_params = action.handler_params
  }
  const stages = action.visible_when_sd_stage
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (stages.length === 1) raw.visible_when = { sd_stage: stages[0] }
  else if (stages.length > 1) raw.visible_when = { sd_stage: stages }
  return raw
}

// ── Workflow draft state ───────────────────────────────────────────────

interface WorkflowState {
  enabled: boolean
  existingId: string | null
  status: string | null
  updated_at: string | null
  label_admin: string
  default_assignee: string
  default_priority: Priority
  task_title_template: string
  description_template: string
  sla: {
    warn_hours: number | ""
    escalate_hours: number | ""
    escalate_to: string
    auto_reassign: boolean
    notify_email_to: string
  } | null
  actions: ActionDraft[]
}

function blankWorkflow(): WorkflowState {
  return {
    enabled: false,
    existingId: null,
    status: null,
    updated_at: null,
    label_admin: "",
    default_assignee: "",
    default_priority: "Normal",
    task_title_template: "{service_type} — {service_name}",
    description_template: "",
    sla: null,
    actions: [],
  }
}

function workflowFromInitial(
  wf: NonNullable<NonNullable<Props["initial"]>["workflow"]>,
): WorkflowState {
  const m = wf.metadata as Record<string, unknown>
  const sla = m.sla as Record<string, unknown> | undefined
  return {
    enabled: true,
    existingId: wf.id,
    status: wf.status,
    updated_at: wf.updated_at,
    label_admin: typeof m.label_admin === "string" ? m.label_admin : "",
    default_assignee: typeof m.default_assignee === "string" ? m.default_assignee : "",
    default_priority:
      typeof m.default_priority === "string" && (PRIORITIES as readonly string[]).includes(m.default_priority)
        ? (m.default_priority as Priority)
        : "Normal",
    task_title_template: typeof m.task_title_template === "string" ? m.task_title_template : "",
    description_template: typeof m.description_template === "string" ? m.description_template : "",
    sla: sla
      ? {
          warn_hours: typeof sla.warn_hours === "number" ? sla.warn_hours : "",
          escalate_hours: typeof sla.escalate_hours === "number" ? sla.escalate_hours : "",
          escalate_to: typeof sla.escalate_to === "string" ? sla.escalate_to : "",
          auto_reassign: sla.auto_reassign === false ? false : true,
          notify_email_to: typeof sla.notify_email_to === "string" ? sla.notify_email_to : "",
        }
      : null,
    actions: Array.isArray(m.actions) ? (m.actions as Record<string, unknown>[]).map(actionFromRaw) : [],
  }
}

function workflowToDraft(wf: WorkflowState, publish: boolean): ServiceWorkflowDraft {
  return {
    slug: "",
    label_admin: wf.label_admin,
    default_assignee: wf.default_assignee,
    default_priority: wf.default_priority,
    task_title_template: wf.task_title_template,
    description_template: wf.description_template,
    sla: wf.sla
      ? {
          warn_hours: typeof wf.sla.warn_hours === "number" ? wf.sla.warn_hours : null,
          escalate_hours: typeof wf.sla.escalate_hours === "number" ? wf.sla.escalate_hours : null,
          escalate_to: wf.sla.escalate_to,
          auto_reassign: wf.sla.auto_reassign,
          notify_email_to: wf.sla.notify_email_to,
        }
      : null,
    actions: wf.actions.map(actionToRaw),
    publish,
    expectedUpdatedAt: wf.updated_at,
    existingId: wf.existingId,
  }
}

// ── Draft state ─────────────────────────────────────────────────────────

function blankBasics(): ServiceBasicsDraft {
  return {
    id: null,
    name: "",
    slug: "",
    category: "addon",
    pipeline: "",
    contract_type: "",
    has_annual: false,
    default_price: null,
    default_currency: "USD",
    description: "",
  }
}

const CATEGORIES = [
  { value: "primary", label: "Primary (Annual Management)" },
  { value: "standalone", label: "Standalone" },
  { value: "addon", label: "Add-on" },
] as const

const inputClass =
  "w-full px-3 py-2 text-sm border border-zinc-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"

// ── Component ──────────────────────────────────────────────────────────

export function ServiceEditClient({ mode, initial }: Props) {
  const router = useRouter()
  const [basics, setBasics] = useState<ServiceBasicsDraft>(
    initial?.basics ?? blankBasics(),
  )
  const [stages, setStages] = useState<StageRow[]>(initial?.stages ?? [])
  const [workflow, setWorkflow] = useState<WorkflowState>(() =>
    initial?.workflow ? workflowFromInitial(initial.workflow) : blankWorkflow(),
  )
  const [saving, setSaving] = useState<null | "draft" | "publish">(null)
  const [issues, setIssues] = useState<CatalogValidityIssue[]>([])
  const [warnings, setWarnings] = useState<string[]>([])

  function patchBasics(p: Partial<ServiceBasicsDraft>) {
    setBasics((b) => ({ ...b, ...p }))
  }

  function addStage() {
    setStages((s) => [...s, { stage_order: s.length + 1, stage_name: "" }])
  }
  function updateStage(idx: number, p: Partial<StageRow>) {
    setStages((s) => s.map((stage, i) => (i === idx ? { ...stage, ...p } : stage)))
  }
  function moveStage(idx: number, dir: -1 | 1) {
    const j = idx + dir
    if (j < 0 || j >= stages.length) return
    setStages((s) => {
      const next = [...s]
      const tmp = next[idx]
      next[idx] = next[j]
      next[j] = tmp
      return next
    })
  }
  function removeStage(idx: number) {
    if (!confirm(`Remove stage "${stages[idx].stage_name || "(unnamed)"}"?`)) return
    setStages((s) => s.filter((_, i) => i !== idx))
  }

  async function handleSave(publish: boolean) {
    if (!basics.name.trim()) {
      toast.error("Name is required.")
      return
    }
    setSaving(publish ? "publish" : "draft")
    setIssues([])
    setWarnings([])
    try {
      const workflowDraft = workflow.enabled ? workflowToDraft(workflow, publish) : null
      const draft: ServiceDraft = { basics, stages, workflow: workflowDraft }
      const result = await saveServiceComplete(draft)
      if (!result.ok) {
        if (result.workflowIssues && result.workflowIssues.length > 0) {
          setIssues(result.workflowIssues)
          toast.error("Workflow validation failed — fix issues below and try again.")
        } else {
          toast.error(result.error ?? "Save failed.")
        }
      } else if (result.service) {
        if (result.warnings && result.warnings.length > 0) {
          setWarnings(result.warnings)
          toast.success("Saved — but heads-up about workflow gaps (see below).")
        } else {
          toast.success(
            publish && workflow.enabled
              ? "Service saved + workflow published."
              : mode === "new"
                ? "Service created."
                : "Service saved.",
          )
        }
        if (mode === "new") {
          router.replace(`/service-catalog/${result.service.slug}/edit`)
        } else {
          router.refresh()
        }
      }
    } finally {
      setSaving(null)
    }
  }

  const title = mode === "new" ? "New Service" : `Edit · ${basics.name || basics.slug}`

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/service-catalog"
          className="inline-flex items-center gap-1 text-sm text-zinc-600 hover:text-zinc-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to service catalog
        </Link>
      </div>
      <h1 className="text-2xl font-semibold text-zinc-900 mb-1">{title}</h1>
      {mode === "edit" && (
        <p className="text-sm text-zinc-500 mb-6 font-mono">{basics.slug}</p>
      )}

      <BasicsSection basics={basics} patch={patchBasics} mode={mode} />
      <StagesSection
        pipeline={basics.pipeline ?? ""}
        stages={stages}
        addStage={addStage}
        updateStage={updateStage}
        moveStage={moveStage}
        removeStage={removeStage}
      />
      <WorkflowSection
        pipeline={basics.pipeline ?? ""}
        workflow={workflow}
        setWorkflow={setWorkflow}
      />

      <section className="mt-6 mb-12 bg-white border rounded-lg p-4">
        {issues.length > 0 && (
          <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded">
            <p className="text-sm font-medium text-red-800 mb-2 flex items-center gap-1">
              <AlertCircle className="h-4 w-4" /> Validation issues
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
        {warnings.length > 0 && (
          <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded">
            <p className="text-sm font-medium text-amber-800 mb-2 flex items-center gap-1">
              <AlertCircle className="h-4 w-4" /> Heads-up — saved, but check these:
            </p>
            <ul className="space-y-1 text-xs text-amber-800 list-disc list-inside">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => handleSave(false)}
            disabled={saving !== null}
            className="px-4 py-2 text-sm border border-zinc-300 rounded hover:bg-zinc-50 disabled:opacity-50"
          >
            {saving === "draft" ? (
              <>
                <Loader2 className="inline h-3.5 w-3.5 animate-spin mr-1" /> Saving…
              </>
            ) : workflow.enabled ? (
              "Save Draft"
            ) : mode === "new" ? (
              "Create Service"
            ) : (
              "Save Changes"
            )}
          </button>
          {workflow.enabled && (
            <button
              type="button"
              onClick={() => handleSave(true)}
              disabled={saving !== null}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {saving === "publish" ? (
                <>
                  <Loader2 className="inline h-3.5 w-3.5 animate-spin mr-1" /> Publishing…
                </>
              ) : (
                <>
                  <CheckCircle2 className="inline h-3.5 w-3.5 mr-1" /> Save + Publish Workflow
                </>
              )}
            </button>
          )}
        </div>
      </section>
    </div>
  )
}

// ── Basics section ─────────────────────────────────────────────────────

function BasicsSection({
  basics,
  patch,
  mode,
}: {
  basics: ServiceBasicsDraft
  patch: (p: Partial<ServiceBasicsDraft>) => void
  mode: "new" | "edit"
}) {
  return (
    <Card title="Basics" description="Identifies the service.">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" required>
          <input
            type="text"
            value={basics.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="e.g. EIN Change of Name"
            className={inputClass}
          />
        </Field>
        <Field
          label="Slug"
          hint={
            mode === "new"
              ? "Auto-derived from name if left blank. Lowercase, underscores."
              : "Locked — slug is immutable after create."
          }
        >
          <input
            type="text"
            value={basics.slug}
            disabled={mode === "edit"}
            onChange={(e) =>
              patch({
                slug: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
              })
            }
            placeholder="ein_change_of_name"
            className={`${inputClass} font-mono ${mode === "edit" ? "bg-zinc-50 text-zinc-500" : ""}`}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Category" required>
          <select
            value={basics.category}
            onChange={(e) => patch({ category: e.target.value })}
            className={inputClass}
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Pipeline name"
          hint="Required for services with stages. Leave blank for one-shot add-ons."
        >
          <input
            type="text"
            value={basics.pipeline ?? ""}
            onChange={(e) => patch({ pipeline: e.target.value })}
            placeholder="e.g. EIN Change Name"
            className={inputClass}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Contract type" hint="Optional. Used by OA/contract generation.">
          <input
            type="text"
            value={basics.contract_type ?? ""}
            onChange={(e) => patch({ contract_type: e.target.value })}
            placeholder="formation"
            className={inputClass}
          />
        </Field>
        <Field label="Default price">
          <div className="flex gap-2">
            <input
              type="text"
              value={basics.default_price?.toString() ?? ""}
              onChange={(e) => {
                const v = e.target.value
                if (v === "") return patch({ default_price: null })
                const n = parseFloat(v)
                if (!Number.isNaN(n)) patch({ default_price: n })
              }}
              placeholder="0"
              className={inputClass}
            />
            <select
              value={basics.default_currency}
              onChange={(e) => patch({ default_currency: e.target.value })}
              className="w-20 px-2 py-2 text-sm border rounded-md"
            >
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
            </select>
          </div>
        </Field>
      </div>
      <Field label="">
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={basics.has_annual}
            onChange={(e) => patch({ has_annual: e.target.checked })}
            className="rounded border-zinc-300"
          />
          Has Annual Renewal
        </label>
      </Field>
      <Field label="Description">
        <textarea
          value={basics.description ?? ""}
          onChange={(e) => patch({ description: e.target.value })}
          rows={2}
          placeholder="Brief description of this service..."
          className={inputClass}
        />
      </Field>
    </Card>
  )
}

// ── Stages section ─────────────────────────────────────────────────────

function StagesSection({
  pipeline,
  stages,
  addStage,
  updateStage,
  moveStage,
  removeStage,
}: {
  pipeline: string
  stages: StageRow[]
  addStage: () => void
  updateStage: (idx: number, p: Partial<StageRow>) => void
  moveStage: (idx: number, dir: -1 | 1) => void
  removeStage: (idx: number) => void
}) {
  if (!pipeline.trim()) {
    return (
      <Card
        title="Stages"
        description="This service has no pipeline name yet. Set a pipeline name in Basics to define stages."
      >
        <p className="text-sm text-zinc-500 italic">
          Stages apply to services with a multi-step lifecycle (Company Formation, ITIN, etc.).
          One-shot add-ons (consulting, single payments) can leave this blank.
        </p>
      </Card>
    )
  }
  return (
    <Card
      title="Stages"
      description={`The lifecycle a service delivery moves through (${stages.length} stage${stages.length === 1 ? "" : "s"}).`}
    >
      {stages.length === 0 && (
        <p className="text-sm text-zinc-500 italic">
          No stages yet. Click + Add Stage to create the first one.
        </p>
      )}
      {stages.map((stage, idx) => (
        <StageCard
          key={idx}
          idx={idx}
          total={stages.length}
          stage={stage}
          onPatch={(p) => updateStage(idx, p)}
          onMove={(dir) => moveStage(idx, dir)}
          onRemove={() => removeStage(idx)}
        />
      ))}
      <button
        type="button"
        onClick={addStage}
        className="mt-2 px-3 py-1.5 text-sm border border-blue-300 text-blue-700 rounded-md hover:bg-blue-50"
      >
        + Add Stage
      </button>
    </Card>
  )
}

function StageCard({
  idx,
  total,
  stage,
  onPatch,
  onMove,
  onRemove,
}: {
  idx: number
  total: number
  stage: StageRow
  onPatch: (p: Partial<StageRow>) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  return (
    <div className="border border-zinc-200 rounded-md p-3 mb-2 bg-zinc-50/30">
      <header className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-zinc-600">
          Stage {idx + 1} of {total}
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={idx === 0}
            className="p-1 rounded hover:bg-zinc-200 disabled:opacity-30"
            aria-label="Move up"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={idx === total - 1}
            className="p-1 rounded hover:bg-zinc-200 disabled:opacity-30"
            aria-label="Move down"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="p-1 rounded text-red-600 hover:bg-red-50"
            aria-label="Remove"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>
      <Field label="Stage name" required>
        <input
          type="text"
          value={stage.stage_name}
          onChange={(e) => onPatch({ stage_name: e.target.value })}
          placeholder="e.g. Data Collection"
          className={inputClass}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="SLA days" hint="Optional. Days before this stage is flagged as overdue.">
          <input
            type="number"
            value={stage.sla_days ?? ""}
            onChange={(e) =>
              onPatch({
                sla_days: e.target.value === "" ? null : parseInt(e.target.value, 10),
              })
            }
            className={inputClass}
            placeholder="7"
          />
        </Field>
        <Field label="Notify client by email when entering this stage?">
          <label className="inline-flex items-center gap-2 text-sm pt-1">
            <input
              type="checkbox"
              checked={!!stage.notify_client_email}
              onChange={(e) => onPatch({ notify_client_email: e.target.checked })}
            />
            yes
          </label>
        </Field>
      </div>
      <Field label="Internal description (admin)" hint="Optional. Shown to staff.">
        <textarea
          value={stage.stage_description ?? ""}
          onChange={(e) => onPatch({ stage_description: e.target.value })}
          rows={2}
          className={inputClass}
        />
      </Field>
    </div>
  )
}

// ── Workflow section ───────────────────────────────────────────────────

const TOKEN_HINTS = ["service_type", "service_name", "account_id", "contact_id", "sd_stage", "service_delivery_id"]

function WorkflowSection({
  pipeline,
  workflow,
  setWorkflow,
}: {
  pipeline: string
  workflow: WorkflowState
  setWorkflow: React.Dispatch<React.SetStateAction<WorkflowState>>
}) {
  if (!pipeline.trim()) {
    return (
      <Card
        title="Workflow"
        description="Set a pipeline name in Basics to define a workflow."
      >
        <p className="text-sm text-zinc-500 italic">
          Workflows attach to multi-stage services. Add-ons without a pipeline don&apos;t need one.
        </p>
      </Card>
    )
  }
  return (
    <Card
      title="Workflow"
      description={`Define the buttons Luca clicks on the task card to advance this service. ${workflow.status ? `Current status: ${workflow.status}.` : "Not configured yet."}`}
    >
      <label className="inline-flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={workflow.enabled}
          onChange={(e) =>
            setWorkflow((w) => ({
              ...w,
              enabled: e.target.checked,
              label_admin: w.label_admin || pipeline,
            }))
          }
        />
        Enable workflow for {pipeline}
      </label>
      {workflow.enabled && (
        <div className="space-y-3 pt-2">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Label (admin)" required>
              <input
                type="text"
                value={workflow.label_admin}
                onChange={(e) => setWorkflow((w) => ({ ...w, label_admin: e.target.value }))}
                placeholder={`${pipeline} Workflow`}
                className={inputClass}
              />
            </Field>
            <Field label="Default assignee" hint="Falls back to DEFAULT_TASK_ASSIGNEE env (today: Luca).">
              <input
                type="text"
                value={workflow.default_assignee}
                onChange={(e) => setWorkflow((w) => ({ ...w, default_assignee: e.target.value }))}
                placeholder="Luca"
                className={inputClass}
              />
            </Field>
          </div>
          <Field label="Default priority">
            <select
              value={workflow.default_priority}
              onChange={(e) => setWorkflow((w) => ({ ...w, default_priority: e.target.value as Priority }))}
              className={inputClass}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex flex-wrap gap-1 text-[11px]">
            <span className="text-zinc-500">Tokens:</span>
            {TOKEN_HINTS.map((tk) => (
              <code key={tk} className="px-1.5 py-0.5 bg-zinc-100 rounded font-mono text-zinc-700">
                {`{${tk}}`}
              </code>
            ))}
          </div>
          <Field
            label="Task title template"
            hint='e.g. "{service_type} — {service_name}"'
          >
            <input
              type="text"
              value={workflow.task_title_template}
              onChange={(e) => setWorkflow((w) => ({ ...w, task_title_template: e.target.value }))}
              className={inputClass}
              placeholder="{service_type} — {service_name}"
            />
          </Field>
          <Field label="Description template">
            <textarea
              value={workflow.description_template}
              rows={2}
              onChange={(e) => setWorkflow((w) => ({ ...w, description_template: e.target.value }))}
              className={inputClass}
            />
          </Field>

          <SlaPanel workflow={workflow} setWorkflow={setWorkflow} />

          <ActionsListEditor workflow={workflow} setWorkflow={setWorkflow} />
        </div>
      )}
    </Card>
  )
}

function SlaPanel({
  workflow,
  setWorkflow,
}: {
  workflow: WorkflowState
  setWorkflow: React.Dispatch<React.SetStateAction<WorkflowState>>
}) {
  const [open, setOpen] = useState(!!workflow.sla)
  const enabled = !!workflow.sla
  function toggle(v: boolean) {
    if (v) {
      setWorkflow((w) => ({
        ...w,
        sla: { warn_hours: "", escalate_hours: "", escalate_to: "Antonio", auto_reassign: true, notify_email_to: "" },
      }))
      setOpen(true)
    } else {
      setWorkflow((w) => ({ ...w, sla: null }))
      setOpen(false)
    }
  }
  function patch(p: Partial<NonNullable<WorkflowState["sla"]>>) {
    setWorkflow((w) => (w.sla ? { ...w, sla: { ...w.sla, ...p } } : w))
  }
  return (
    <div className="border border-zinc-200 rounded p-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 text-sm font-medium"
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          SLA
        </button>
        <label className="inline-flex items-center gap-2 text-xs">
          <input type="checkbox" checked={enabled} onChange={(e) => toggle(e.target.checked)} />
          Enable SLA
        </label>
      </div>
      {open && enabled && workflow.sla && (
        <div className="pt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Warn after (hours)">
              <input
                type="number"
                value={workflow.sla.warn_hours}
                onChange={(e) =>
                  patch({ warn_hours: e.target.value === "" ? "" : parseFloat(e.target.value) })
                }
                className={inputClass}
                placeholder="24"
              />
            </Field>
            <Field label="Escalate after (hours)">
              <input
                type="number"
                value={workflow.sla.escalate_hours}
                onChange={(e) =>
                  patch({ escalate_hours: e.target.value === "" ? "" : parseFloat(e.target.value) })
                }
                className={inputClass}
                placeholder="72"
              />
            </Field>
          </div>
          <Field label="Escalate to (assignee)">
            <input
              type="text"
              value={workflow.sla.escalate_to}
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
                  checked={workflow.sla.auto_reassign}
                  onChange={(e) => patch({ auto_reassign: e.target.checked })}
                />
                yes
              </label>
            </Field>
            <Field label="Notify email" hint="Default: support@tonydurante.us. Empty = suppress.">
              <input
                type="text"
                value={workflow.sla.notify_email_to}
                onChange={(e) => patch({ notify_email_to: e.target.value })}
                className={inputClass}
              />
            </Field>
          </div>
        </div>
      )}
    </div>
  )
}

function ActionsListEditor({
  workflow,
  setWorkflow,
}: {
  workflow: WorkflowState
  setWorkflow: React.Dispatch<React.SetStateAction<WorkflowState>>
}) {
  const handlerSlugs = useMemo(() => getRegisteredHandlerParamSchemaSlugs().sort(), [])

  function updateAction(idx: number, patch: Partial<ActionDraft>) {
    setWorkflow((w) => ({
      ...w,
      actions: w.actions.map((a, i) => (i === idx ? { ...a, ...patch } : a)),
    }))
  }
  function move(idx: number, dir: -1 | 1) {
    const j = idx + dir
    if (j < 0 || j >= workflow.actions.length) return
    setWorkflow((w) => {
      const next = [...w.actions]
      const tmp = next[idx]
      next[idx] = next[j]
      next[j] = tmp
      return { ...w, actions: next }
    })
  }
  function remove(idx: number) {
    if (!confirm(`Remove action "${workflow.actions[idx].label_admin || workflow.actions[idx].slug || "(unnamed)"}"?`)) return
    setWorkflow((w) => ({ ...w, actions: w.actions.filter((_, i) => i !== idx) }))
  }
  function add() {
    setWorkflow((w) => ({ ...w, actions: [...w.actions, newAction()] }))
  }

  return (
    <div>
      <p className="text-xs font-semibold text-zinc-700 mb-2">Action buttons (workflow steps)</p>
      {workflow.actions.length === 0 && (
        <p className="text-xs text-zinc-500 italic mb-2">
          No actions yet. Click + Add Action to add the first step.
        </p>
      )}
      {workflow.actions.map((action, idx) => (
        <ActionCard
          key={action._editorKey}
          idx={idx}
          total={workflow.actions.length}
          action={action}
          handlerSlugs={handlerSlugs}
          onPatch={(p) => updateAction(idx, p)}
          onMove={(dir) => move(idx, dir)}
          onRemove={() => remove(idx)}
        />
      ))}
      <button
        type="button"
        onClick={add}
        className="mt-1 px-3 py-1.5 text-xs border border-blue-300 text-blue-700 rounded-md hover:bg-blue-50"
      >
        + Add Action
      </button>
    </div>
  )
}

function ActionCard({
  idx,
  total,
  action,
  handlerSlugs,
  onPatch,
  onMove,
  onRemove,
}: {
  idx: number
  total: number
  action: ActionDraft
  handlerSlugs: string[]
  onPatch: (p: Partial<ActionDraft>) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  const paramsSpec = useMemo(() => {
    if (!action.handler) return null
    const schema = getHandlerParamSchema(action.handler)
    if (!schema) return null
    return introspect(schema, { label: "handler_params" })
  }, [action.handler])

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
            className="p-1 rounded hover:bg-zinc-200 disabled:opacity-30"
            aria-label="Move up"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={idx === total - 1}
            className="p-1 rounded hover:bg-zinc-200 disabled:opacity-30"
            aria-label="Move down"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="p-1 rounded text-red-600 hover:bg-red-50"
            aria-label="Remove action"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Slug" required>
          <input
            type="text"
            value={action.slug}
            onChange={(e) => onPatch({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
            placeholder="approve_and_apply"
            className={inputClass}
          />
        </Field>
        <Field label="Label (admin)" required>
          <input
            type="text"
            value={action.label_admin}
            onChange={(e) => onPatch({ label_admin: e.target.value })}
            placeholder="Approve & Apply"
            className={inputClass}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Handler" required>
          <select
            value={action.handler}
            onChange={(e) => onPatch({ handler: e.target.value, handler_params: {} })}
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
      <Field label="Visible when (SD stage)" hint='Stage-aware buttons. CSV. Empty = always visible.'>
        <input
          type="text"
          value={action.visible_when_sd_stage}
          onChange={(e) => onPatch({ visible_when_sd_stage: e.target.value })}
          placeholder="EIN Application, State Filing"
          className={inputClass}
        />
      </Field>
      {action.handler && paramsSpec && (
        <div className="mt-2 pt-2 border-t border-zinc-200">
          <p className="text-xs font-semibold text-zinc-700 mb-2">handler_params</p>
          {paramsSpec.kind === "object" && Object.keys(paramsSpec.fields).length === 0 ? (
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
          )}
        </div>
      )}
    </div>
  )
}

// ── Layout primitives ──────────────────────────────────────────────────

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
      {label && (
        <label className="block text-xs font-medium text-zinc-800 mb-1">
          {label}
          {required && <span className="ml-0.5 text-red-600">*</span>}
        </label>
      )}
      {children}
      {hint && <p className="mt-1 text-[11px] text-zinc-500">{hint}</p>}
    </div>
  )
}
