/**
 * P3.6 — Config table editor.
 *
 * CRM surface for editing sop_runbooks, pipeline_stages, dev_tasks — tables
 * that previously were edited exclusively via raw execute_sql. One page,
 * three tabs, edit dialog per row. All writes go through lib/operations/
 * config.ts which logs to action_log.
 *
 * Plan reference: restructure-plan-final-v1 §4 line 642.
 */

import Link from "next/link"
import { Settings, FileText, Workflow, ListTodo } from "lucide-react"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { SOPEditButton, type SOPRow } from "./sop-edit-dialog"
import {
  PipelineStageEditButton,
  type PipelineStageRow,
} from "./pipeline-stage-edit-dialog"
import { DevTaskEditButton, type DevTaskRow } from "./dev-task-edit-dialog"

export const dynamic = "force-dynamic"
export const revalidate = 0

const SERVICE_TYPES = [
  "Company Formation",
  "Client Onboarding",
  "Tax Return",
  "State RA Renewal",
  "CMRA",
  "Shipping",
  "Public Notary",
  "Banking Fintech",
  "Banking Physical",
  "ITIN",
  "Company Closure",
  "Client Offboarding",
  "State Annual Report",
  "EIN Application",
  "Support",
]

type Tab = "sops" | "pipeline" | "dev-tasks"

function isTab(v: string | undefined): v is Tab {
  return v === "sops" || v === "pipeline" || v === "dev-tasks"
}

async function fetchSOPs(): Promise<SOPRow[]> {
  const { data } = await supabaseAdmin
    .from("sop_runbooks")
    .select("id, title, service_type, version, notes, content, updated_at")
    .order("service_type", { ascending: true })
    .order("title", { ascending: true })
  return (data ?? []) as SOPRow[]
}

async function fetchPipelineStages(): Promise<PipelineStageRow[]> {
  const { data } = await supabaseAdmin
    .from("pipeline_stages")
    .select(
      "id, service_type, stage_order, stage_name, stage_description, client_description, sla_days, auto_advance, requires_approval",
    )
    .order("service_type", { ascending: true })
    .order("stage_order", { ascending: true })
  return (data ?? []) as PipelineStageRow[]
}

async function fetchDevTasks(statusFilter: string | undefined): Promise<DevTaskRow[]> {
  let query = supabaseAdmin
    .from("dev_tasks")
    .select("id, title, status, priority, type, description, decisions, blockers, updated_at")
    .order("updated_at", { ascending: false })
    .limit(100)

  if (statusFilter && statusFilter !== "all") {
    query = query.eq("status", statusFilter as never)
  } else {
    query = query.in("status", ["backlog", "todo", "in_progress", "blocked"] as never)
  }

  const { data } = await query
  return (data ?? []) as DevTaskRow[]
}

function TabLink({ href, active, icon: Icon, label, count }: {
  href: string
  active: boolean
  icon: React.ElementType
  label: string
  count: number
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        active
          ? "border-blue-600 text-blue-700"
          : "border-transparent text-zinc-600 hover:text-zinc-900"
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
      <span className={`text-xs rounded-full px-1.5 py-0.5 ${active ? "bg-blue-100 text-blue-700" : "bg-zinc-200 text-zinc-600"}`}>
        {count}
      </span>
    </Link>
  )
}

export default async function ConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; dev_status?: string }>
}) {
  const sp = await searchParams
  const tab: Tab = isTab(sp.tab) ? sp.tab : "sops"

  // Fetch all three in parallel. Each table is small (17 / 56 / ≤100 rows);
  // fetching all three lets the tab nav show live counts without a second
  // round-trip.
  const [sops, pipeline, devTasks] = await Promise.all([
    fetchSOPs(),
    fetchPipelineStages(),
    fetchDevTasks(sp.dev_status),
  ])

  return (
    <div className="p-6 lg:p-8 max-w-7xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Settings className="h-6 w-6" />
          Config
        </h1>
        <p className="mt-1 text-sm text-zinc-600">
          Edit SOPs, pipeline stages, and dev tasks. Every save goes through the
          operations layer and is logged to action_log.
        </p>
      </div>

      <nav className="flex items-center gap-1 border-b border-zinc-200 mb-6">
        <TabLink href="/config?tab=sops" active={tab === "sops"} icon={FileText} label="SOPs" count={sops.length} />
        <TabLink href="/config?tab=pipeline" active={tab === "pipeline"} icon={Workflow} label="Pipeline Stages" count={pipeline.length} />
        <TabLink href="/config?tab=dev-tasks" active={tab === "dev-tasks"} icon={ListTodo} label="Dev Tasks" count={devTasks.length} />
      </nav>

      {tab === "sops" && <SOPsTab rows={sops} />}
      {tab === "pipeline" && <PipelineTab rows={pipeline} />}
      {tab === "dev-tasks" && <DevTasksTab rows={devTasks} activeStatus={sp.dev_status ?? "open"} />}
    </div>
  )
}

function SOPsTab({ rows }: { rows: SOPRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-zinc-500">No SOPs.</p>
  }
  return (
    <div className="border rounded-lg overflow-hidden bg-white">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left text-xs uppercase text-zinc-500">
          <tr>
            <th className="px-4 py-2 font-medium">Service</th>
            <th className="px-4 py-2 font-medium">Title</th>
            <th className="px-4 py-2 font-medium">Version</th>
            <th className="px-4 py-2 font-medium">Notes</th>
            <th className="px-4 py-2 font-medium w-20"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {rows.map(r => (
            <tr key={r.id}>
              <td className="px-4 py-2 text-zinc-600">{r.service_type ?? "—"}</td>
              <td className="px-4 py-2 font-medium text-zinc-900">{r.title}</td>
              <td className="px-4 py-2 text-zinc-600">{r.version ?? "—"}</td>
              <td className="px-4 py-2 text-zinc-500 max-w-xs truncate">{r.notes ?? ""}</td>
              <td className="px-4 py-2 text-right">
                <SOPEditButton row={r} serviceTypes={SERVICE_TYPES} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PipelineTab({ rows }: { rows: PipelineStageRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-zinc-500">No pipeline stages.</p>
  }
  // Group by service_type for readability.
  const grouped = rows.reduce<Record<string, PipelineStageRow[]>>((acc, r) => {
    (acc[r.service_type] ||= []).push(r)
    return acc
  }, {})
  return (
    <div className="space-y-4">
      {Object.entries(grouped).map(([serviceType, stages]) => (
        <section key={serviceType} className="border rounded-lg overflow-hidden bg-white">
          <header className="px-4 py-2 bg-zinc-50 border-b text-xs font-semibold uppercase text-zinc-600">
            {serviceType}
          </header>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-zinc-500 bg-zinc-50/50">
              <tr>
                <th className="px-4 py-2 font-medium w-12">#</th>
                <th className="px-4 py-2 font-medium">Stage</th>
                <th className="px-4 py-2 font-medium">SLA</th>
                <th className="px-4 py-2 font-medium">Flags</th>
                <th className="px-4 py-2 font-medium w-20"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {stages.map(s => (
                <tr key={s.id}>
                  <td className="px-4 py-2 text-zinc-500">{s.stage_order}</td>
                  <td className="px-4 py-2">
                    <div className="font-medium text-zinc-900">{s.stage_name}</div>
                    {s.stage_description && (
                      <div className="text-xs text-zinc-500 mt-0.5">{s.stage_description}</div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-zinc-600">{s.sla_days != null ? `${s.sla_days}d` : "—"}</td>
                  <td className="px-4 py-2 text-xs text-zinc-600">
                    {s.auto_advance ? "Auto " : ""}
                    {s.requires_approval ? "Approval " : ""}
                    {!s.auto_advance && !s.requires_approval ? "—" : ""}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <PipelineStageEditButton row={s} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
}

function DevTasksTab({ rows, activeStatus }: { rows: DevTaskRow[]; activeStatus: string }) {
  const filters: Array<{ value: string; label: string }> = [
    { value: "open", label: "Open" },
    { value: "todo", label: "To Do" },
    { value: "in_progress", label: "In Progress" },
    { value: "blocked", label: "Blocked" },
    { value: "done", label: "Done" },
    { value: "all", label: "All" },
  ]

  return (
    <>
      <div className="flex items-center gap-2 mb-3">
        {filters.map(f => (
          <Link
            key={f.value}
            href={`/config?tab=dev-tasks${f.value === "open" ? "" : `&dev_status=${f.value}`}`}
            className={`text-xs px-2 py-1 rounded border ${
              activeStatus === f.value
                ? "bg-blue-50 border-blue-300 text-blue-700"
                : "border-zinc-200 text-zinc-600 hover:bg-zinc-50"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">No tasks.</p>
      ) : (
        <div className="border rounded-lg overflow-hidden bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-2 font-medium">Priority</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 font-medium w-20"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="px-4 py-2">
                    <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${
                      r.priority === "critical" ? "bg-red-100 text-red-700"
                      : r.priority === "high" ? "bg-amber-100 text-amber-700"
                      : r.priority === "medium" ? "bg-blue-100 text-blue-700"
                      : "bg-zinc-100 text-zinc-600"
                    }`}>
                      {r.priority}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-zinc-600">{r.status}</td>
                  <td className="px-4 py-2 text-zinc-500">{r.type}</td>
                  <td className="px-4 py-2 font-medium text-zinc-900 max-w-xl truncate">{r.title}</td>
                  <td className="px-4 py-2 text-right">
                    <DevTaskEditButton row={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
