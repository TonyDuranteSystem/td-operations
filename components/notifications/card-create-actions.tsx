'use client'

/**
 * CardCreateActions — the two money-touching one-click actions for a To-Do card
 * or a What's New note: "Create service" and "Create invoice". STAFF-ONLY.
 *
 * Both REUSE the canonical paths (never rebuild):
 *   • Create service → POST /api/crm/admin-actions/create-service (→ createSD,
 *     which also auto-invoices when the catalog has a default price). service_type
 *     is the catalog `pipeline` value, sourced from /api/service-catalog exactly
 *     like the account page's Add-Service dialog.
 *   • Create invoice → the canonical InvoiceDialog + createInvoice server action,
 *     which carries content-based idempotency (R098) so a double-click never makes
 *     a duplicate. Billing always flows through an ACCOUNT (an individual gets one
 *     auto-created via the dialog's "New Customer" — createOneTimeCustomer makes a
 *     contact + account). So Invoice shows for BOTH account and contact cards: an
 *     account card pre-fills its account; a contact card opens the dialog so staff
 *     pick/confirm the individual's account (their personal account, their company,
 *     or create a new customer) — the correct, flexible billing target per service
 *     (ITIN/Individual TR → personal; Business TR → company).
 *
 * Both require an explicit confirm (the modal/dialog submit) — nothing fires on a
 * single click. createSD can spawn its own workflow + What's New note (expected
 * echo). See sysdoc notification-center-phase2-cards-summary-plan (P4).
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Briefcase, FileText, X, Loader2 } from 'lucide-react'
import { InvoiceDialog } from '@/components/payments/invoice-dialog'
import { createInvoice } from '@/app/(dashboard)/payments/invoice-actions'

interface SvcOption { id: string; name: string; pipeline: string | null }

export function CardCreateActions({
  accountId,
  contactId,
  clientName,
  onDone,
}: {
  accountId?: string | null
  contactId?: string | null
  clientName?: string
  onDone?: () => void
}) {
  const [svcOpen, setSvcOpen] = useState(false)
  const [invOpen, setInvOpen] = useState(false)

  if (!accountId && !contactId) return null

  return (
    <>
      <div className="flex items-center gap-1">
        <button
          onClick={() => setSvcOpen(true)}
          className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-800 border rounded px-1.5 py-0.5"
          title="Create a service for this client"
        >
          <Briefcase className="h-3 w-3" /> Service
        </button>
        <button
          onClick={() => setInvOpen(true)}
          className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-800 border rounded px-1.5 py-0.5"
          title="Create an invoice for this client"
        >
          <FileText className="h-3 w-3" /> Invoice
        </button>
      </div>

      {svcOpen && (
        <ServicePicker
          accountId={accountId ?? null}
          contactId={contactId ?? null}
          onClose={() => setSvcOpen(false)}
          onCreated={() => { setSvcOpen(false); onDone?.() }}
        />
      )}

      <InvoiceDialog
        open={invOpen}
        onClose={() => setInvOpen(false)}
        mode="invoice"
        // Account card → pre-fill its account. Contact card → leave the customer
        // unset so staff pick/confirm the individual's account (or create one),
        // which is the correct billing target for an individual.
        defaultValues={accountId ? { accountId, accountName: clientName } : undefined}
        onCreateInvoice={async (input) => {
          const r = await createInvoice(input)
          if (r.success) { toast.success('Invoice created (Draft)'); onDone?.() }
          return r
        }}
      />
    </>
  )
}

/** Small modal: pick a catalog service (pipeline value) + optional note, then
 *  create the SD via the canonical endpoint. Confirm = the Create button. */
function ServicePicker({
  accountId,
  contactId,
  onClose,
  onCreated,
}: {
  accountId: string | null
  contactId: string | null
  onClose: () => void
  onCreated: () => void
}) {
  const [options, setOptions] = useState<SvcOption[]>([])
  const [loading, setLoading] = useState(true)
  const [serviceType, setServiceType] = useState('')
  const [notes, setNotes] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Contact-only scope → only services that legitimately exist on a contact.
    const url = !accountId && contactId ? '/api/service-catalog?contact_eligible=true' : '/api/service-catalog'
    fetch(url)
      .then((r) => r.json())
      .then((d: { services?: Array<SvcOption & { active?: boolean }> }) => {
        if (cancelled) return
        const list = (d.services ?? [])
          .filter((s) => s.active !== false && typeof s.pipeline === 'string' && (s.pipeline as string).trim().length > 0)
          .map((s) => ({ id: s.id, name: s.name, pipeline: s.pipeline }))
          .sort((a, b) => a.name.localeCompare(b.name))
        setOptions(list)
      })
      .catch(() => { if (!cancelled) setError('Failed to load the service catalog') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [accountId, contactId])

  const create = useCallback(async () => {
    if (!serviceType || creating) return
    setCreating(true); setError(null)
    try {
      const res = await fetch('/api/crm/admin-actions/create-service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, contact_id: contactId, service_type: serviceType, notes: notes.trim() || undefined }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.success) throw new Error(d.error || 'Could not create the service')
      toast.success(`${serviceType} created`)
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the service')
    } finally {
      setCreating(false)
    }
  }, [serviceType, notes, accountId, contactId, creating, onCreated])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-sm font-semibold">Create a service</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          {error && <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded px-2 py-1.5">{error}</div>}
          <div>
            <label className="block text-[11px] font-medium text-zinc-500 mb-1">Service type</label>
            <select
              value={serviceType}
              onChange={(e) => setServiceType(e.target.value)}
              disabled={loading}
              className="w-full text-sm border rounded px-2 py-1.5 bg-white disabled:bg-zinc-50"
            >
              <option value="">{loading ? 'Loading…' : 'Select…'}</option>
              {options.map((o) => {
                const value = o.pipeline ?? o.name
                return <option key={o.id} value={value}>{o.name}</option>
              })}
            </select>
            {!loading && options.length === 0 && (
              <p className="mt-1 text-xs text-amber-700">No catalog services with a pipeline are available.</p>
            )}
          </div>
          <div>
            <label className="block text-[11px] font-medium text-zinc-500 mb-1">Note (optional)</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full text-sm border rounded px-2 py-1.5 resize-none" />
          </div>
          <button
            disabled={!serviceType || creating}
            onClick={create}
            className="w-full flex items-center justify-center gap-1 text-sm font-medium bg-zinc-900 text-white rounded px-3 py-2 disabled:opacity-40"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Briefcase className="h-4 w-4" />}
            {creating ? 'Creating…' : 'Create service'}
          </button>
        </div>
      </div>
    </div>
  )
}
