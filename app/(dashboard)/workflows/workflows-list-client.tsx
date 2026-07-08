"use client"

import Link from "next/link"
import { Plus, AlertCircle } from "lucide-react"
import type { CatalogEntry } from "@/lib/catalog/framework"

interface Props {
  entries: CatalogEntry[]
}

/**
 * List view for /workflows. Renders every task_workflows catalog row with
 * a quick-glance summary: status badge, trigger summary, action count,
 * last-edited timestamp. The trigger summary lets you scan whether the
 * catalog is healthy (chained workflows have no trigger; that's expected;
 * orphan workflows with no trigger and no chain-spawn reference are not
 * useful — Phase 1c's validity gate would surface those at publish time).
 */
export function WorkflowsListClient({ entries }: Props) {
  if (entries.length === 0) {
    return (
      <EmptyState />
    )
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
        <Link
          href="/workflows/new"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          New Workflow
        </Link>
      </div>
      <div className="bg-white border rounded-lg overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-zinc-50 text-zinc-600 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-4 py-2">Slug</th>
              <th className="text-left px-4 py-2">Label</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-left px-4 py-2">Trigger</th>
              <th className="text-left px-4 py-2">Actions</th>
              <th className="text-left px-4 py-2">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {entries.map((entry) => (
              <WorkflowRow key={entry.slug} entry={entry} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="bg-white border rounded-lg p-12 text-center">
      <h2 className="text-base font-medium text-zinc-800 mb-2">No workflows yet</h2>
      <p className="text-sm text-zinc-500 mb-6">
        Add your first workflow to start automating a service lifecycle.
      </p>
      <Link
        href="/workflows/new"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
      >
        <Plus className="h-4 w-4" />
        New Workflow
      </Link>
    </div>
  )
}

function WorkflowRow({ entry }: { entry: CatalogEntry }) {
  const meta = (entry.metadata ?? {}) as Record<string, unknown>
  const label =
    typeof meta.label_admin === "string" ? meta.label_admin : entry.display_name ?? entry.slug
  const actions = Array.isArray(meta.actions) ? meta.actions.length : 0
  const triggerSummary = summarizeTrigger(meta.triggered_by)
  const updatedAt = entry.updated_at ? new Date(entry.updated_at).toLocaleString() : "—"

  return (
    <tr className="hover:bg-zinc-50">
      <td className="px-4 py-2 font-mono text-xs text-zinc-700">
        <Link href={`/workflows/${entry.slug}`} className="text-blue-700 hover:underline">
          {entry.slug}
        </Link>
      </td>
      <td className="px-4 py-2 text-zinc-900">{label}</td>
      <td className="px-4 py-2">
        <StatusBadge status={entry.status} />
      </td>
      <td className="px-4 py-2 text-zinc-700">{triggerSummary}</td>
      <td className="px-4 py-2 text-zinc-700">{actions}</td>
      <td className="px-4 py-2 text-zinc-500 text-xs">{updatedAt}</td>
    </tr>
  )
}

const STATUS_STYLES: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  deprecated: "bg-zinc-200 text-zinc-600",
  exception_only: "bg-amber-100 text-amber-800",
}

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? "bg-zinc-100 text-zinc-700"
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status}
    </span>
  )
}

function summarizeTrigger(raw: unknown): React.ReactNode {
  if (!raw || typeof raw !== "object") {
    return <span className="text-zinc-400 italic">none (chain-spawned)</span>
  }
  const t = raw as Record<string, unknown>
  const source = typeof t.source === "string" ? t.source : null
  if (source === "form_submission") {
    const table = typeof t.table === "string" ? t.table : "?"
    const filter =
      t.filter && typeof t.filter === "object"
        ? Object.entries(t.filter as Record<string, unknown>)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(", ")
        : ""
    return (
      <span>
        form: <span className="font-mono">{table}</span>
        {filter && <span className="text-zinc-500"> · {filter}</span>}
      </span>
    )
  }
  if (source === "sd_created") {
    const filter =
      t.filter && typeof t.filter === "object"
        ? Object.entries(t.filter as Record<string, unknown>)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(", ")
        : ""
    return (
      <span>
        SD: <span className="font-mono">{filter || "(any)"}</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-amber-700">
      <AlertCircle className="h-3 w-3" /> unknown source
    </span>
  )
}
