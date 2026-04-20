'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, ExternalLink, Loader2, Trash2, Check } from 'lucide-react'
import { toast } from 'sonner'

interface BankReferral {
  slug: string
  label: string
  apply_url: string
  enabled: boolean
  created_at: string
  updated_at: string
}

export function BankReferralsAdmin() {
  const [referrals, setReferrals] = useState<BankReferral[]>([])
  const [loading, setLoading] = useState(true)
  const [showDialog, setShowDialog] = useState(false)
  const [busySlug, setBusySlug] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/crm/bank-referrals')
      const json = await res.json()
      setReferrals(json.referrals ?? [])
    } catch {
      toast.error('Failed to load bank referrals')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const toggleEnabled = async (slug: string, enabled: boolean) => {
    setBusySlug(slug)
    try {
      const res = await fetch(`/api/crm/bank-referrals/${slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'patch failed')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setBusySlug(null)
    }
  }

  const remove = async (slug: string, label: string) => {
    if (!confirm(`Remove "${label}"? Clients will no longer see this bank on their portal.`)) return
    setBusySlug(slug)
    try {
      const res = await fetch(`/api/crm/bank-referrals/${slug}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'delete failed')
      if (json.disabled) toast.info('Disabled (has click history — kept for reporting)')
      else toast.success('Removed')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusySlug(null)
    }
  }

  return (
    <div className="mt-6 bg-white rounded-lg border p-5">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-base font-semibold">Partner Bank Links</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Banks clients apply to directly via an external link. No wizard or document collection — we just track whether they clicked.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowDialog(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700"
        >
          <Plus className="h-3.5 w-3.5" /> Add Bank Link
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : referrals.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">No partner banks yet. Click &quot;Add Bank Link&quot; to add one.</p>
      ) : (
        <div className="divide-y">
          {referrals.map(r => (
            <div key={r.slug} className="flex items-center gap-3 py-2.5">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{r.label}</span>
                  {!r.enabled && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">Disabled</span>
                  )}
                </div>
                <a
                  href={r.apply_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-zinc-500 hover:text-blue-600 inline-flex items-center gap-1 truncate max-w-md"
                >
                  {r.apply_url}
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              </div>
              <button
                type="button"
                onClick={() => toggleEnabled(r.slug, !r.enabled)}
                disabled={busySlug === r.slug}
                className={`text-xs px-2.5 py-1 rounded-md border ${r.enabled ? 'border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50'}`}
              >
                {r.enabled ? <><Check className="h-3 w-3 inline mr-0.5" /> Enabled</> : 'Disabled'}
              </button>
              <button
                type="button"
                onClick={() => remove(r.slug, r.label)}
                disabled={busySlug === r.slug}
                className="text-zinc-400 hover:text-red-600 p-1"
                title="Remove"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {showDialog && (
        <AddBankDialog
          onClose={() => setShowDialog(false)}
          onCreated={async () => { setShowDialog(false); await load() }}
        />
      )}
    </div>
  )
}

function AddBankDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [label, setLabel] = useState('')
  const [applyUrl, setApplyUrl] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!label.trim() || !applyUrl.trim()) {
      toast.error('Label and apply URL are required')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/crm/bank-referrals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim(), apply_url: applyUrl.trim() }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'create failed')
      toast.success(`Added ${json.referral.label}`)
      onCreated()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Create failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-lg p-5 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-4">Add Partner Bank Link</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Bank name</label>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. Sokin"
              className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Apply URL</label>
            <input
              type="url"
              value={applyUrl}
              onChange={e => setApplyUrl(e.target.value)}
              placeholder="https://sokin.com/apply?ref=..."
              className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-muted-foreground mt-1">
              The URL clients are redirected to. Include your partner/referral code if any.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 text-sm font-medium rounded-md border hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Add Bank
          </button>
        </div>
      </div>
    </div>
  )
}
