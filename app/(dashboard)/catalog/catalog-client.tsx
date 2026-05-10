"use client"

import { useState, useTransition } from "react"
import { Plus, Pencil, Tag, ArchiveX, RotateCcw, Loader2, X, AlertTriangle } from "lucide-react"
import { toast } from "sonner"
import type { CatalogEntry, CatalogPendingReview } from "@/lib/catalog/framework"
import {
  addCatalogEntry,
  deprecateCatalogEntry,
  rejectPending,
  renameCatalogEntry,
  resolvePendingAlias,
  restoreCatalogEntry,
  retagCatalogEntry,
} from "./actions"

interface Props {
  catalogId: string
  entries: CatalogEntry[]
  pending: CatalogPendingReview[]
}

type EditMode =
  | { kind: "add" }
  | { kind: "rename"; entry: CatalogEntry }
  | { kind: "tag"; entry: CatalogEntry }
  | { kind: "deprecate"; entry: CatalogEntry }
  | { kind: "restore"; entry: CatalogEntry }
  | null

type PendingMode =
  | { kind: "alias"; row: CatalogPendingReview }
  | { kind: "reject"; row: CatalogPendingReview }
  | null

const STATUS_BADGE: Record<CatalogEntry["status"], string> = {
  active: "bg-green-100 text-green-800",
  deprecated: "bg-gray-200 text-gray-600 line-through",
  exception_only: "bg-amber-100 text-amber-800",
}

function StatusBadge({ status }: { status: CatalogEntry["status"] }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[status]}`}>
      {status}
    </span>
  )
}

function TagPill({ tag }: { tag: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-xs font-mono mr-1 mb-1">
      {tag}
    </span>
  )
}

function TranslationFlags({ entry }: { entry: CatalogEntry }) {
  const langs = Object.keys(entry.display_name_translations ?? {}).filter(
    (k) => entry.display_name_translations[k]?.trim(),
  )
  if (langs.length === 0) return <span className="text-gray-300 text-xs">—</span>
  return (
    <span className="text-xs">
      {langs.map((l) => (
        <span key={l} title={entry.display_name_translations[l]} className="mr-1">
          {l === "it" ? "🇮🇹" : l === "en" ? "🇺🇸" : l}
        </span>
      ))}
    </span>
  )
}

export function CatalogClient({ catalogId, entries, pending }: Props) {
  const [mode, setMode] = useState<EditMode>(null)
  const [pendingMode, setPendingMode] = useState<PendingMode>(null)
  const [busy, setBusy] = useState(false)
  const [, startTransition] = useTransition()

  const refresh = () => startTransition(() => window.location.reload())

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-gray-700">
          {entries.length} entries · {pending.length} pending review
        </h2>
        <button
          onClick={() => setMode({ kind: "add" })}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded font-medium"
        >
          <Plus className="w-4 h-4" />
          Add Entry
        </button>
      </div>

      <div className="border rounded-lg overflow-hidden bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-3 py-2 text-left">Slug</th>
              <th className="px-3 py-2 text-left">Display Name</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Tags</th>
              <th className="px-3 py-2 text-left">Translations</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t hover:bg-gray-50">
                <td className="px-3 py-2 font-mono text-xs">{e.slug}</td>
                <td className="px-3 py-2">{e.display_name}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={e.status} />
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap">
                    {(e.tags ?? []).map((t) => (
                      <TagPill key={t} tag={t} />
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <TranslationFlags entry={e} />
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button
                    onClick={() => setMode({ kind: "rename", entry: e })}
                    title="Rename"
                    className="p-1.5 text-gray-500 hover:text-blue-600"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setMode({ kind: "tag", entry: e })}
                    title="Edit tags"
                    className="p-1.5 text-gray-500 hover:text-blue-600"
                  >
                    <Tag className="w-4 h-4" />
                  </button>
                  {e.status === "deprecated" ? (
                    <button
                      onClick={() => setMode({ kind: "restore", entry: e })}
                      title="Restore"
                      className="p-1.5 text-gray-500 hover:text-green-600"
                    >
                      <RotateCcw className="w-4 h-4" />
                    </button>
                  ) : (
                    <button
                      onClick={() => setMode({ kind: "deprecate", entry: e })}
                      title="Deprecate"
                      className="p-1.5 text-gray-500 hover:text-red-600"
                    >
                      <ArchiveX className="w-4 h-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pending Review section */}
      <div className="mt-10">
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-500" />
          Pending Review ({pending.length})
        </h2>
        <p className="text-xs text-gray-500 mt-1 mb-3">
          Unrecognized values from external sources (Whop, Stripe, forms, …). Map each one to an existing slug, or reject.
        </p>
        {pending.length === 0 ? (
          <div className="text-sm text-gray-400 italic">No pending items.</div>
        ) : (
          <div className="border rounded-lg overflow-hidden bg-white">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 text-left">Submitted Value</th>
                  <th className="px-3 py-2 text-left">Source</th>
                  <th className="px-3 py-2 text-left">Created</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((p) => (
                  <tr key={p.id} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-xs">{p.submitted_value}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">{p.source}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">
                      {new Date(p.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => setPendingMode({ kind: "alias", row: p })}
                        className="px-2 py-1 text-xs bg-blue-50 text-blue-700 hover:bg-blue-100 rounded mr-1"
                      >
                        Resolve
                      </button>
                      <button
                        onClick={() => setPendingMode({ kind: "reject", row: p })}
                        className="px-2 py-1 text-xs bg-red-50 text-red-700 hover:bg-red-100 rounded"
                      >
                        Reject
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {mode && (
        <EntryModal
          mode={mode}
          catalogId={catalogId}
          busy={busy}
          onClose={() => setMode(null)}
          onSubmit={async (work) => {
            setBusy(true)
            try {
              await work()
              setMode(null)
              refresh()
            } finally {
              setBusy(false)
            }
          }}
        />
      )}

      {pendingMode && (
        <PendingModal
          mode={pendingMode}
          entries={entries}
          busy={busy}
          onClose={() => setPendingMode(null)}
          onSubmit={async (work) => {
            setBusy(true)
            try {
              await work()
              setPendingMode(null)
              refresh()
            } finally {
              setBusy(false)
            }
          }}
        />
      )}
    </>
  )
}

// ── Entry modal ─────────────────────────────────────────────────────────

function EntryModal({
  mode,
  catalogId,
  busy,
  onClose,
  onSubmit,
}: {
  mode: EditMode
  catalogId: string
  busy: boolean
  onClose: () => void
  onSubmit: (work: () => Promise<void>) => Promise<void>
}) {
  if (!mode) return null

  const title =
    mode.kind === "add"
      ? "Add Entry"
      : mode.kind === "rename"
        ? `Rename ${mode.entry.slug}`
        : mode.kind === "tag"
          ? `Edit tags — ${mode.entry.slug}`
          : mode.kind === "deprecate"
            ? `Deprecate ${mode.entry.slug}`
            : `Restore ${mode.entry.slug}`

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-semibold text-gray-900">{title}</h3>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5">
          {mode.kind === "add" && (
            <AddForm catalogId={catalogId} busy={busy} onSubmit={onSubmit} onCancel={onClose} />
          )}
          {mode.kind === "rename" && (
            <RenameForm
              catalogId={catalogId}
              entry={mode.entry}
              busy={busy}
              onSubmit={onSubmit}
              onCancel={onClose}
            />
          )}
          {mode.kind === "tag" && (
            <TagForm
              catalogId={catalogId}
              entry={mode.entry}
              busy={busy}
              onSubmit={onSubmit}
              onCancel={onClose}
            />
          )}
          {(mode.kind === "deprecate" || mode.kind === "restore") && (
            <ReasonOnlyForm
              actionLabel={mode.kind === "deprecate" ? "Deprecate" : "Restore"}
              danger={mode.kind === "deprecate"}
              busy={busy}
              onSubmit={(reason) =>
                onSubmit(async () => {
                  const fn = mode.kind === "deprecate" ? deprecateCatalogEntry : restoreCatalogEntry
                  const res = await fn({ catalog_id: catalogId, slug: mode.entry.slug, reason })
                  if (!res.success) throw new Error(res.error || "Failed")
                  toast.success(`${mode.entry.slug} ${mode.kind}d`)
                })
              }
              onCancel={onClose}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function AddForm({
  catalogId,
  busy,
  onSubmit,
  onCancel,
}: {
  catalogId: string
  busy: boolean
  onSubmit: (work: () => Promise<void>) => Promise<void>
  onCancel: () => void
}) {
  const [slug, setSlug] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [description, setDescription] = useState("")
  const [status, setStatus] = useState<"active" | "deprecated" | "exception_only">("active")
  const [tagsText, setTagsText] = useState("")
  const [reason, setReason] = useState("")

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!slug.trim() || !displayName.trim() || !reason.trim()) {
      toast.error("Slug, display name, and reason are all required")
      return
    }
    if (!/^[a-z0-9_]+$/.test(slug)) {
      toast.error("Slug must be lowercase snake_case (a-z, 0-9, _)")
      return
    }
    const tags = tagsText.split(",").map((t) => t.trim()).filter(Boolean)
    await onSubmit(async () => {
      const res = await addCatalogEntry({
        catalog_id: catalogId,
        slug,
        display_name: displayName,
        description,
        status,
        tags,
        reason,
      })
      if (!res.success) throw new Error(res.error || "Failed to add")
      toast.success(`Added ${slug}`)
    })
  }

  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <Field label="Slug *">
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="lowercase_snake_case"
          className="w-full border rounded px-2 py-1.5 font-mono text-xs"
        />
      </Field>
      <Field label="Display Name *">
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full border rounded px-2 py-1.5"
        />
      </Field>
      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full border rounded px-2 py-1.5"
        />
      </Field>
      <Field label="Status">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          className="w-full border rounded px-2 py-1.5"
        >
          <option value="active">active</option>
          <option value="exception_only">exception_only</option>
          <option value="deprecated">deprecated</option>
        </select>
      </Field>
      <Field label="Tags (comma-separated)">
        <input
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder="service, sellable"
          className="w-full border rounded px-2 py-1.5 font-mono text-xs"
        />
      </Field>
      <Field label="Reason * (audit log)">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          placeholder="Why is this entry being added?"
          className="w-full border rounded px-2 py-1.5"
        />
      </Field>
      <FormButtons busy={busy} onCancel={onCancel} label="Add Entry" />
    </form>
  )
}

function RenameForm({
  catalogId,
  entry,
  busy,
  onSubmit,
  onCancel,
}: {
  catalogId: string
  entry: CatalogEntry
  busy: boolean
  onSubmit: (work: () => Promise<void>) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(entry.display_name)
  const [reason, setReason] = useState("")

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !reason.trim()) {
      toast.error("Display name and reason are required")
      return
    }
    await onSubmit(async () => {
      const res = await renameCatalogEntry({
        catalog_id: catalogId,
        slug: entry.slug,
        new_display_name: name,
        reason,
      })
      if (!res.success) throw new Error(res.error || "Failed to rename")
      toast.success(`Renamed ${entry.slug}`)
    })
  }

  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <Field label="Display Name *">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full border rounded px-2 py-1.5"
        />
      </Field>
      <Field label="Reason * (audit log)">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          className="w-full border rounded px-2 py-1.5"
        />
      </Field>
      <FormButtons busy={busy} onCancel={onCancel} label="Rename" />
    </form>
  )
}

function TagForm({
  catalogId,
  entry,
  busy,
  onSubmit,
  onCancel,
}: {
  catalogId: string
  entry: CatalogEntry
  busy: boolean
  onSubmit: (work: () => Promise<void>) => Promise<void>
  onCancel: () => void
}) {
  const [tagsText, setTagsText] = useState((entry.tags ?? []).join(", "))
  const [reason, setReason] = useState("")

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!reason.trim()) {
      toast.error("Reason is required")
      return
    }
    const tags = tagsText.split(",").map((t) => t.trim()).filter(Boolean)
    await onSubmit(async () => {
      const res = await retagCatalogEntry({
        catalog_id: catalogId,
        slug: entry.slug,
        tags,
        reason,
      })
      if (!res.success) throw new Error(res.error || "Failed to update tags")
      toast.success(`Tags updated for ${entry.slug}`)
    })
  }

  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <Field label="Tags (comma-separated)">
        <input
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          className="w-full border rounded px-2 py-1.5 font-mono text-xs"
        />
      </Field>
      <Field label="Reason * (audit log)">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          className="w-full border rounded px-2 py-1.5"
        />
      </Field>
      <FormButtons busy={busy} onCancel={onCancel} label="Save Tags" />
    </form>
  )
}

function ReasonOnlyForm({
  actionLabel,
  danger,
  busy,
  onSubmit,
  onCancel,
}: {
  actionLabel: string
  danger: boolean
  busy: boolean
  onSubmit: (reason: string) => Promise<void>
  onCancel: () => void
}) {
  const [reason, setReason] = useState("")
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!reason.trim()) {
      toast.error("Reason is required")
      return
    }
    await onSubmit(reason)
  }
  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <Field label="Reason * (audit log)">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          className="w-full border rounded px-2 py-1.5"
        />
      </Field>
      <FormButtons busy={busy} onCancel={onCancel} label={actionLabel} danger={danger} />
    </form>
  )
}

// ── Pending modal ───────────────────────────────────────────────────────

function PendingModal({
  mode,
  entries,
  busy,
  onClose,
  onSubmit,
}: {
  mode: PendingMode
  entries: CatalogEntry[]
  busy: boolean
  onClose: () => void
  onSubmit: (work: () => Promise<void>) => Promise<void>
}) {
  if (!mode) return null

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-semibold text-gray-900">
            {mode.kind === "alias" ? "Resolve Pending" : "Reject Pending"}
          </h3>
          <button onClick={onClose} disabled={busy} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5">
          <div className="text-sm text-gray-700 mb-3">
            Submitted value:{" "}
            <span className="font-mono text-xs px-2 py-0.5 bg-gray-100 rounded">
              {mode.row.submitted_value}
            </span>
            <div className="text-xs text-gray-500 mt-1">
              source: {mode.row.source} · catalog: {mode.row.catalog_id}
            </div>
          </div>
          {mode.kind === "alias" ? (
            <AliasForm
              row={mode.row}
              entries={entries.filter(
                (e) => e.catalog_id === mode.row.catalog_id && e.status !== "deprecated",
              )}
              busy={busy}
              onSubmit={onSubmit}
              onCancel={onClose}
            />
          ) : (
            <RejectForm row={mode.row} busy={busy} onSubmit={onSubmit} onCancel={onClose} />
          )}
        </div>
      </div>
    </div>
  )
}

function AliasForm({
  row,
  entries,
  busy,
  onSubmit,
  onCancel,
}: {
  row: CatalogPendingReview
  entries: CatalogEntry[]
  busy: boolean
  onSubmit: (work: () => Promise<void>) => Promise<void>
  onCancel: () => void
}) {
  const [slug, setSlug] = useState("")
  const [reason, setReason] = useState("")
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!slug || !reason.trim()) {
      toast.error("Pick a target slug and provide a reason")
      return
    }
    await onSubmit(async () => {
      const res = await resolvePendingAlias({
        pending_id: row.id,
        catalog_id: row.catalog_id,
        resolved_to_slug: slug,
        reason,
      })
      if (!res.success) throw new Error(res.error || "Failed to resolve")
      toast.success(`Aliased to ${slug}`)
    })
  }
  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <Field label="Map to existing slug *">
        <select
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          className="w-full border rounded px-2 py-1.5 font-mono text-xs"
        >
          <option value="">— choose —</option>
          {entries.map((e) => (
            <option key={e.id} value={e.slug}>
              {e.slug} — {e.display_name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Reason * (audit log)">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          className="w-full border rounded px-2 py-1.5"
        />
      </Field>
      <FormButtons busy={busy} onCancel={onCancel} label="Resolve" />
    </form>
  )
}

function RejectForm({
  row,
  busy,
  onSubmit,
  onCancel,
}: {
  row: CatalogPendingReview
  busy: boolean
  onSubmit: (work: () => Promise<void>) => Promise<void>
  onCancel: () => void
}) {
  const [reason, setReason] = useState("")
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!reason.trim()) {
      toast.error("Reason is required")
      return
    }
    await onSubmit(async () => {
      const res = await rejectPending({ pending_id: row.id, reason })
      if (!res.success) throw new Error(res.error || "Failed to reject")
      toast.success("Rejected")
    })
  }
  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <Field label="Reason * (audit log)">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          className="w-full border rounded px-2 py-1.5"
        />
      </Field>
      <FormButtons busy={busy} onCancel={onCancel} label="Reject" danger />
    </form>
  )
}

// ── Shared form bits ────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-700 mb-1">{label}</span>
      {children}
    </label>
  )
}

function FormButtons({
  busy,
  onCancel,
  label,
  danger,
}: {
  busy: boolean
  onCancel: () => void
  label: string
  danger?: boolean
}) {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="px-3 py-1.5 text-sm border rounded text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={busy}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded text-white font-medium disabled:opacity-50 ${
          danger ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"
        }`}
      >
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
        {label}
      </button>
    </div>
  )
}
