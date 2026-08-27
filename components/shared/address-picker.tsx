'use client'

import { useState, useEffect, useCallback } from 'react'
import { Pencil, Plus, Loader2, X, ShieldCheck, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { AddressDropdown } from '@/components/shared/address-dropdown'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import type { AddressRow } from '@/lib/addresses'
import { updateAccountField } from '@/app/(dashboard)/accounts/actions'

// Only the two non-RA kinds are valid for this picker.
type LegalMailingKind = 'business_legal' | 'business_mailing'

export interface AddressPickerProps {
  accountId: string
  accountUpdatedAt: string
  kind: LegalMailingKind
  value: string | null       // business_legal_address_id or business_mailing_address_id
  verified: boolean          // legal_link_verified or mailing_link_verified
  onChange: () => void       // call after any successful mutation; parent re-fetches account
}

// Which accounts column each kind writes to.
const FK_FIELD: Record<LegalMailingKind, string> = {
  business_legal: 'business_legal_address_id',
  business_mailing: 'business_mailing_address_id',
}

// Which verified flag each kind flips.
const VERIFIED_FIELD: Record<LegalMailingKind, string> = {
  business_legal: 'legal_link_verified',
  business_mailing: 'mailing_link_verified',
}

// Human-readable label used in dialog titles and toasts.
const KIND_LABEL: Record<LegalMailingKind, string> = {
  business_legal: 'legal address',
  business_mailing: 'mailing address',
}

interface AddressForm {
  name: string
  address_line1: string
  address_line2: string
  city: string
  state: string
  zip: string
  is_td_provided: boolean
  notes: string
}

const EMPTY_FORM: AddressForm = {
  name: '', address_line1: '', address_line2: '',
  city: '', state: '', zip: '',
  is_td_provided: false, notes: '',
}

function rowToForm(row: AddressRow): AddressForm {
  return {
    name: row.name,
    address_line1: row.address_line1,
    address_line2: row.address_line2 ?? '',
    city: row.city,
    state: row.state,
    zip: row.zip,
    is_td_provided: row.is_td_provided,
    notes: row.notes ?? '',
  }
}

// ── AddressFormFields ─────────────────────────────────────────────────────────

function AddressFormFields({
  form,
  onChange: onFieldChange,
}: {
  form: AddressForm
  onChange: (f: AddressForm) => void
}) {
  const input = (key: keyof AddressForm, placeholder?: string) => (
    <input
      type="text"
      value={form[key] as string}
      onChange={e => onFieldChange({ ...form, [key]: e.target.value })}
      placeholder={placeholder}
      className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  )

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-zinc-600 mb-1">
          Display name <span className="text-red-500">*</span>
        </label>
        {input('name')}
        <p className="mt-0.5 text-xs text-zinc-400">e.g. &quot;TD Office — Clearwater, FL&quot;</p>
      </div>

      <div>
        <label className="block text-xs font-medium text-zinc-600 mb-1">
          Address line 1 <span className="text-red-500">*</span>
        </label>
        {input('address_line1')}
      </div>

      <div>
        <label className="block text-xs font-medium text-zinc-600 mb-1">Address line 2</label>
        {input('address_line2', 'Suite, unit, etc.')}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium text-zinc-600 mb-1">
            City <span className="text-red-500">*</span>
          </label>
          {input('city')}
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-600 mb-1">
            State <span className="text-red-500">*</span>
          </label>
          {input('state', 'FL')}
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-600 mb-1">
            ZIP <span className="text-red-500">*</span>
          </label>
          {input('zip')}
        </div>
      </div>

      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.is_td_provided}
            onChange={e => onFieldChange({ ...form, is_td_provided: e.target.checked })}
            className="h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-sm text-zinc-700">TD-provided address</span>
        </label>
        <p className="mt-0.5 text-xs text-zinc-400 pl-6">Check if this is a TD CMRA / registered office address</p>
      </div>

      <div>
        <label className="block text-xs font-medium text-zinc-600 mb-1">Notes</label>
        {input('notes')}
      </div>
    </div>
  )
}

// ── AddressPicker ─────────────────────────────────────────────────────────────

export function AddressPicker({
  accountId,
  accountUpdatedAt,
  kind,
  value,
  verified,
  onChange,
}: AddressPickerProps) {
  const [dropdownKey, setDropdownKey] = useState(0)
  const [fetchedRows, setFetchedRows] = useState<AddressRow[]>([])
  const [fetchLoading, setFetchLoading] = useState(false)
  const [modal, setModal] = useState<'none' | 'edit' | 'add'>('none')
  const [form, setForm] = useState<AddressForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [pickSaving, setPickSaving] = useState(false)
  const [verifySaving, setVerifySaving] = useState(false)

  const selectedRow = fetchedRows.find(r => r.id === value) ?? null
  const label = KIND_LABEL[kind]
  const fkField = FK_FIELD[kind]
  const verifiedField = VERIFIED_FIELD[kind]

  // ── Fetch registry rows ────────────────────────────────────────────────────

  const fetchRows = useCallback(async () => {
    setFetchLoading(true)
    try {
      const res = await fetch(`/api/addresses?kind=${encodeURIComponent(kind)}&active=true`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load addresses')
      setFetchedRows(data as AddressRow[])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load addresses')
    } finally {
      setFetchLoading(false)
    }
  }, [kind])

  // Fetch on mount when value is already set (pre-populate Edit button data).
  useEffect(() => {
    if (value) fetchRows()
  }, [value, fetchRows])

  // After any mutation: refetch rows + force AddressDropdown to refetch its list.
  const afterMutation = useCallback(async () => {
    await fetchRows()
    setDropdownKey(k => k + 1)
    onChange()
  }, [fetchRows, onChange])

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleDropdownChange = async (row: AddressRow | null) => {
    const newId = row?.id ?? ''
    setPickSaving(true)
    try {
      const r1 = await updateAccountField(accountId, fkField, newId, accountUpdatedAt)
      if (!r1.success) {
        toast.error(r1.error ?? `Failed to update ${label}`)
        return
      }
      // Reset verified flag when switching to a different row.
      if (row && verified) {
        await updateAccountField(accountId, verifiedField, 'false', accountUpdatedAt)
      }
      await afterMutation()
      toast.success(row ? `${label.charAt(0).toUpperCase() + label.slice(1)} updated` : `${label.charAt(0).toUpperCase() + label.slice(1)} cleared`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update')
    } finally {
      setPickSaving(false)
    }
  }

  const openEdit = () => {
    if (!selectedRow) return
    setForm(rowToForm(selectedRow))
    setModal('edit')
  }

  const openAdd = () => {
    setForm(EMPTY_FORM)
    setModal('add')
  }

  const closeModal = () => {
    if (!saving) setModal('none')
  }

  // Save Edit — PATCH /api/addresses/[id]
  const handleSaveEdit = async () => {
    if (!selectedRow) return
    setSaving(true)
    try {
      const res = await fetch(`/api/addresses/${selectedRow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          address_line1: form.address_line1.trim(),
          address_line2: form.address_line2.trim() || null,
          city: form.city.trim(),
          state: form.state.trim(),
          zip: form.zip.trim(),
          is_td_provided: form.is_td_provided,
          notes: form.notes.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to save')
      setModal('none')
      await afterMutation()
      toast.success('Registry entry updated')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  // Save Add New — POST /api/addresses, then link the new row to this account
  const handleSaveAdd = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          name: form.name.trim(),
          address_line1: form.address_line1.trim(),
          address_line2: form.address_line2.trim() || null,
          city: form.city.trim(),
          state: form.state.trim(),
          zip: form.zip.trim(),
          is_td_provided: form.is_td_provided,
          notes: form.notes.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to create')

      if (data.warning) toast.warning(data.warning)

      const r1 = await updateAccountField(accountId, fkField, data.id, accountUpdatedAt)
      if (!r1.success) {
        toast.error(r1.error ?? 'Address created but failed to link — set it manually from the dropdown')
        return
      }
      setModal('none')
      await afterMutation()
      toast.success(`New ${label} created and linked`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create')
    } finally {
      setSaving(false)
    }
  }

  // Flip verified flag → true
  const handleVerify = async () => {
    setVerifySaving(true)
    try {
      const r = await updateAccountField(accountId, verifiedField, 'true', accountUpdatedAt)
      if (!r.success) {
        toast.error(r.error ?? 'Failed to verify')
        return
      }
      onChange()
      toast.success(`${label.charAt(0).toUpperCase() + label.slice(1)} link verified`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setVerifySaving(false)
    }
  }

  const formValid =
    form.name.trim() &&
    form.address_line1.trim() &&
    form.city.trim() &&
    form.state.trim() &&
    form.zip.trim()

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-1.5">
      {/* Picker row */}
      <div className="flex items-center gap-2">
        <AddressDropdown
          key={dropdownKey}
          kind={kind}
          value={value}
          onChange={handleDropdownChange}
          disabled={pickSaving || saving}
          className="flex-1 min-w-0"
        />

        {/* Edit button — only when a row is selected */}
        {value && (
          <FastTooltip label={`Edit this ${label} entry`}>
            <button
              type="button"
              onClick={openEdit}
              disabled={!selectedRow || saving || fetchLoading}
              aria-label={`Edit this ${label} entry`}
              className="shrink-0 p-2 rounded-md border hover:bg-zinc-50 disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {fetchLoading
                ? <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                : <Pencil className="h-4 w-4 text-zinc-500" />
              }
            </button>
          </FastTooltip>
        )}

        {/* Add New button — always visible */}
        <FastTooltip label={`Add new ${label} entry`}>
          <button
            type="button"
            onClick={openAdd}
            disabled={saving || pickSaving}
            aria-label={`Add new ${label} entry`}
            className="shrink-0 flex items-center gap-1 px-2.5 py-2 text-xs text-blue-600 rounded-md border hover:bg-blue-50 disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <Plus className="h-3.5 w-3.5" />
            New
          </button>
        </FastTooltip>
      </div>

      {/* Verification status — only when a row is selected */}
      {value && (
        <div className="flex items-center gap-2 pl-0.5">
          {verified ? (
            <span className="flex items-center gap-1 text-xs text-green-700">
              <ShieldCheck className="h-3.5 w-3.5" />
              Verified
            </span>
          ) : (
            <button
              type="button"
              onClick={handleVerify}
              disabled={verifySaving}
              className="flex items-center gap-1 text-xs text-amber-700 hover:text-amber-900 disabled:opacity-50"
            >
              {verifySaving
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <ShieldAlert className="h-3.5 w-3.5" />
              }
              Mark as verified
            </button>
          )}
        </div>
      )}

      {/* Edit / Add dialog */}
      {modal !== 'none' && (
        <>
          <div className="fixed inset-0 z-50 bg-black/50" onClick={closeModal} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div
              className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col"
              onClick={e => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
                <h2 className="text-base font-semibold text-zinc-900">
                  {modal === 'edit'
                    ? `Edit ${label} entry`
                    : `Add new ${label} entry`}
                </h2>
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={saving}
                  className="p-1 rounded hover:bg-zinc-100 disabled:opacity-50"
                >
                  <X className="h-5 w-5 text-zinc-500" />
                </button>
              </div>

              {/* N-accounts warning for Edit */}
              {modal === 'edit' && selectedRow && selectedRow.linked_account_count > 1 && (
                <div className="mx-6 mt-4 p-3 bg-amber-50 border border-amber-200 rounded-md text-sm text-amber-800">
                  <strong>Note:</strong> This entry is linked to{' '}
                  <strong>{selectedRow.linked_account_count} accounts</strong>. Saving will update it for all of them.
                </div>
              )}

              {/* Form body */}
              <div className="px-6 py-4 overflow-y-auto">
                <AddressFormFields form={form} onChange={setForm} />
              </div>

              {/* Footer */}
              <div className="flex items-center justify-end gap-2 px-6 py-3 border-t shrink-0">
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={saving}
                  className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={modal === 'edit' ? handleSaveEdit : handleSaveAdd}
                  disabled={saving || !formValid}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md disabled:opacity-50"
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {modal === 'edit' ? 'Save changes' : 'Create & link'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
