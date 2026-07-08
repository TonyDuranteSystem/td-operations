'use client'

import { useState, useEffect, useCallback } from 'react'
import { Plus, Pencil, Trash2, Loader2, MapPin, ShieldCheck, AlertCircle, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { AddressRow } from '@/lib/addresses'

// ─── Types ───────────────────────────────────────────────────────────────────

type TabKind = 'registered_agent' | 'business_legal' | 'business_mailing'

interface AddressForm {
  name: string
  provider: string
  agent_name: string
  address_line1: string
  address_line2: string
  city: string
  state: string
  zip: string
  county: string
  is_td_provided: boolean
  notes: string
}

const EMPTY_FORM: AddressForm = {
  name: '', provider: '', agent_name: '',
  address_line1: '', address_line2: '',
  city: '', state: '', zip: '', county: '',
  is_td_provided: false, notes: '',
}

const TABS: { kind: TabKind; label: string }[] = [
  { kind: 'registered_agent', label: 'Registered Agents' },
  { kind: 'business_legal', label: 'Legal Addresses' },
  { kind: 'business_mailing', label: 'Mailing Addresses' },
]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rowToForm(row: AddressRow): AddressForm {
  return {
    name: row.name,
    provider: row.provider ?? '',
    agent_name: row.agent_name ?? '',
    address_line1: row.address_line1,
    address_line2: row.address_line2 ?? '',
    city: row.city,
    state: row.state,
    zip: row.zip,
    county: row.county ?? '',
    is_td_provided: row.is_td_provided,
    notes: row.notes ?? '',
  }
}

function formValid(form: AddressForm): boolean {
  return !!(form.name.trim() && form.address_line1.trim() && form.city.trim() && form.state.trim() && form.zip.trim())
}

function fmtAddress(row: AddressRow): string {
  const parts = [row.address_line1]
  if (row.address_line2) parts.push(row.address_line2)
  parts.push(`${row.city}, ${row.state} ${row.zip}`)
  return parts.join(', ')
}

// ─── Form fields ─────────────────────────────────────────────────────────────

function FormField({ label, value, onChange, placeholder, required }: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  required?: boolean
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-zinc-600 mb-1">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  )
}

function AddressFormFields({
  form,
  kind,
  onChange,
}: {
  form: AddressForm
  kind: TabKind
  onChange: (f: AddressForm) => void
}) {
  const f = (key: keyof AddressForm, label: string, opts?: { placeholder?: string; required?: boolean }) => (
    <FormField
      key={key}
      label={label}
      value={form[key] as string}
      onChange={v => onChange({ ...form, [key]: v })}
      {...opts}
    />
  )

  return (
    <div className="space-y-3">
      {f('name', 'Display name', { required: true, placeholder: kind === 'registered_agent' ? 'e.g. Registered Agents Inc — Santa Fe, NM' : 'e.g. TD Office — Clearwater, FL' })}

      {kind === 'registered_agent' && (
        <>
          {f('provider', 'Provider (vendor TD pays)', { placeholder: 'e.g. Harbor Compliance, Northwest, Direct' })}
          {f('agent_name', 'Agent name (on filing)', { placeholder: 'e.g. Registered Agents Inc' })}
        </>
      )}

      {f('address_line1', 'Address line 1', { required: true })}
      {f('address_line2', 'Address line 2', { placeholder: 'Suite, unit, etc.' })}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {f('city', 'City', { required: true })}
        {f('state', 'State', { required: true, placeholder: 'FL' })}
        {f('zip', 'ZIP', { required: true })}
      </div>

      {kind === 'registered_agent' && (
        f('county', 'County', { placeholder: 'e.g. Sheridan (for SS-4 Line 6)' })
      )}

      {kind !== 'registered_agent' && (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.is_td_provided}
            onChange={e => onChange({ ...form, is_td_provided: e.target.checked })}
            className="h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-sm text-zinc-700">TD-provided address (CMRA / registered office)</span>
        </label>
      )}

      {f('notes', 'Notes')}
    </div>
  )
}

// ─── Add / Edit dialog ────────────────────────────────────────────────────────

function AddressDialog({
  kind,
  editRow,
  onClose,
  onSaved,
}: {
  kind: TabKind
  editRow: AddressRow | null
  onClose: () => void
  onSaved: (row: AddressRow) => void
}) {
  const isEdit = editRow !== null
  const [form, setForm] = useState<AddressForm>(editRow ? rowToForm(editRow) : EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!formValid(form)) return
    setSaving(true)
    try {
      const body = {
        kind,
        name: form.name.trim(),
        provider: form.provider.trim() || null,
        agent_name: form.agent_name.trim() || null,
        address_line1: form.address_line1.trim(),
        address_line2: form.address_line2.trim() || null,
        city: form.city.trim(),
        state: form.state.trim().toUpperCase(),
        zip: form.zip.trim(),
        county: form.county.trim() || null,
        is_td_provided: form.is_td_provided,
        notes: form.notes.trim() || null,
      }

      let res: Response
      if (isEdit) {
        res = await fetch(`/api/addresses/${editRow!.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } else {
        res = await fetch('/api/addresses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      }

      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to save')
      if (data.warning) toast.warning(data.warning)
      toast.success(isEdit ? 'Registry entry updated' : 'Registry entry created')
      onSaved(data as AddressRow)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={() => { if (!saving) onClose() }} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
            <h2 className="text-base font-semibold text-zinc-900">
              {isEdit ? 'Edit registry entry' : 'Add new registry entry'}
            </h2>
            <button type="button" onClick={onClose} disabled={saving} className="p-1 rounded hover:bg-zinc-100 disabled:opacity-50">
              <X className="h-5 w-5 text-zinc-500" />
            </button>
          </div>

          {isEdit && editRow && editRow.linked_account_count > 1 && (
            <div className="mx-6 mt-4 p-3 bg-amber-50 border border-amber-200 rounded-md text-sm text-amber-800">
              <strong>Note:</strong> This entry is linked to <strong>{editRow.linked_account_count} accounts</strong>. Saving will update it for all of them.
            </div>
          )}

          <div className="px-6 py-4 overflow-y-auto">
            <AddressFormFields form={form} kind={kind} onChange={setForm} />
          </div>

          <div className="flex items-center justify-end gap-2 px-6 py-3 border-t shrink-0">
            <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50 disabled:opacity-50">
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !formValid(form)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {isEdit ? 'Save changes' : 'Create entry'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function AddressRowItem({
  row,
  kind,
  onEdit,
  onDeactivated,
}: {
  row: AddressRow
  kind: TabKind
  onEdit: (row: AddressRow) => void
  onDeactivated: (id: string) => void
}) {
  const [deactivating, setDeactivating] = useState(false)

  async function handleDeactivate() {
    if (!confirm(`Deactivate "${row.name}"? It will be hidden from all pickers.`)) return
    setDeactivating(true)
    try {
      const res = await fetch(`/api/addresses/${row.id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to deactivate')
      toast.success('Entry deactivated')
      onDeactivated(row.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setDeactivating(false)
    }
  }

  return (
    <div className={cn('border-b border-zinc-100 px-4 py-3 hover:bg-zinc-50 transition-colors', !row.active && 'opacity-50')}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{row.name}</span>
            {row.is_td_provided && (
              <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded-full font-medium">TD</span>
            )}
            {row.linked_account_count > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 bg-zinc-100 text-zinc-600 rounded-full">
                {row.linked_account_count} linked
              </span>
            )}
            {!row.active && (
              <span className="text-[10px] px-1.5 py-0.5 bg-zinc-200 text-zinc-500 rounded-full">Inactive</span>
            )}
          </div>

          <p className="text-xs text-zinc-500 mt-0.5">{fmtAddress(row)}</p>

          {kind === 'registered_agent' && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-zinc-400">
              {row.agent_name && <span><span className="text-zinc-500 font-medium">Agent:</span> {row.agent_name}</span>}
              {row.provider && <span><span className="text-zinc-500 font-medium">Provider:</span> {row.provider}</span>}
              {row.county ? (
                <span className="flex items-center gap-1 text-emerald-600">
                  <ShieldCheck className="h-3 w-3" />
                  {row.county} County
                </span>
              ) : (
                <span className="flex items-center gap-1 text-amber-600">
                  <AlertCircle className="h-3 w-3" />
                  No county (SS-4 blocker)
                </span>
              )}
            </div>
          )}

          {row.notes && <p className="text-xs text-zinc-400 mt-0.5 italic">{row.notes}</p>}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => onEdit(row)}
            className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500 hover:text-zinc-700"
            title="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          {row.active && (
            <button
              type="button"
              onClick={handleDeactivate}
              disabled={deactivating || row.linked_account_count > 0}
              title={row.linked_account_count > 0 ? `Cannot deactivate — ${row.linked_account_count} account(s) linked` : 'Deactivate'}
              className="p-1.5 rounded hover:bg-red-50 text-zinc-400 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {deactivating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function AddressesPage() {
  const [activeTab, setActiveTab] = useState<TabKind>('registered_agent')
  const [rows, setRows] = useState<Record<TabKind, AddressRow[]>>({
    registered_agent: [],
    business_legal: [],
    business_mailing: [],
  })
  const [loading, setLoading] = useState<Record<TabKind, boolean>>({
    registered_agent: false,
    business_legal: false,
    business_mailing: false,
  })
  const [showInactive, setShowInactive] = useState(false)
  const [editRow, setEditRow] = useState<AddressRow | null>(null)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [loaded, setLoaded] = useState<Set<TabKind>>(new Set())

  const fetchKind = useCallback(async (kind: TabKind) => {
    setLoading(prev => ({ ...prev, [kind]: true }))
    try {
      const res = await fetch(`/api/addresses?kind=${kind}&active=${showInactive ? 'false' : 'true'}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      // Also fetch inactive rows and merge when showInactive is true
      if (showInactive) {
        const resActive = await fetch(`/api/addresses?kind=${kind}&active=true`)
        const activeData = await resActive.json()
        const merged = [...(activeData as AddressRow[]), ...(data as AddressRow[])].sort((a, b) => a.name.localeCompare(b.name))
        setRows(prev => ({ ...prev, [kind]: merged }))
      } else {
        setRows(prev => ({ ...prev, [kind]: data as AddressRow[] }))
      }
      setLoaded(prev => { const next = new Set(prev); next.add(kind); return next })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load addresses')
    } finally {
      setLoading(prev => ({ ...prev, [kind]: false }))
    }
  }, [showInactive])

  useEffect(() => {
    fetchKind(activeTab)
  }, [activeTab, fetchKind])

  function handleSaved(savedRow: AddressRow) {
    const kind = savedRow.kind as TabKind
    setRows(prev => {
      const existing = prev[kind].find(r => r.id === savedRow.id)
      if (existing) {
        return { ...prev, [kind]: prev[kind].map(r => r.id === savedRow.id ? savedRow : r) }
      }
      return { ...prev, [kind]: [...prev[kind], savedRow].sort((a, b) => a.name.localeCompare(b.name)) }
    })
    setEditRow(null)
    setShowAddDialog(false)
  }

  function handleDeactivated(id: string) {
    if (showInactive) {
      setRows(prev => ({
        ...prev,
        [activeTab]: prev[activeTab].map(r => r.id === id ? { ...r, active: false } : r),
      }))
    } else {
      setRows(prev => ({
        ...prev,
        [activeTab]: prev[activeTab].filter(r => r.id !== id),
      }))
    }
  }

  const currentRows = rows[activeTab]
  const isLoading = loading[activeTab] && !loaded.has(activeTab)

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      {/* Header */}
      <div className="border-b bg-white px-6 py-4 shrink-0">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-zinc-400" />
            <div>
              <h1 className="text-lg font-semibold">Address Registry</h1>
              <p className="text-xs text-muted-foreground">Shared address records for legal, mailing, and registered agent addresses</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-zinc-500 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={e => setShowInactive(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-zinc-300"
              />
              Show inactive
            </label>
            <button
              type="button"
              onClick={() => setShowAddDialog(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md"
            >
              <Plus className="h-4 w-4" />
              Add entry
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-4">
          {TABS.map(tab => (
            <button
              key={tab.kind}
              onClick={() => setActiveTab(tab.kind)}
              className={cn(
                'px-4 py-1.5 text-sm rounded-md transition-colors',
                activeTab === tab.kind
                  ? 'bg-zinc-900 text-white'
                  : 'text-zinc-600 hover:bg-zinc-100'
              )}
            >
              {tab.label}
              {rows[tab.kind].length > 0 && (
                <span className={cn(
                  'ml-2 text-xs px-1.5 py-0.5 rounded-full',
                  activeTab === tab.kind ? 'bg-white/20 text-white' : 'bg-zinc-100 text-zinc-500'
                )}>
                  {rows[tab.kind].length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto bg-white">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Loading…
          </div>
        ) : currentRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-zinc-400 gap-2">
            <MapPin className="h-8 w-8" />
            <p className="text-sm">No entries yet</p>
            <button
              type="button"
              onClick={() => setShowAddDialog(true)}
              className="text-sm text-blue-600 hover:underline"
            >
              Add the first one
            </button>
          </div>
        ) : (
          <div>
            {currentRows.map(row => (
              <AddressRowItem
                key={row.id}
                row={row}
                kind={activeTab}
                onEdit={r => setEditRow(r)}
                onDeactivated={handleDeactivated}
              />
            ))}
          </div>
        )}
      </div>

      {/* Dialogs */}
      {(editRow || showAddDialog) && (
        <AddressDialog
          kind={activeTab}
          editRow={editRow}
          onClose={() => { setEditRow(null); setShowAddDialog(false) }}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}
