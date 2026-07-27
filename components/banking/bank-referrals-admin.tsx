'use client'

/**
 * Bank catalog admin — the ONLY place banks are added, edited, reordered or
 * removed. Since 2026-07-27 this feeds the client-facing Bank Applications
 * page (/portal/banks) directly; before that the page carried its own
 * hardcoded array and the two lists drifted. Adding a bank here puts it in
 * front of clients, so every field the tile renders is editable here.
 */

import { useCallback, useEffect, useState } from 'react'
import { Plus, ExternalLink, Loader2, Trash2, Check, Pencil, ChevronUp, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'

interface BankReferral {
  slug: string
  label: string
  apply_url: string
  rep_email: string | null
  tag: string | null
  description_en: string | null
  description_it: string | null
  managed: boolean
  sort_order: number
  enabled: boolean
  created_at: string
  updated_at: string
}

export function BankReferralsAdmin() {
  const [referrals, setReferrals] = useState<BankReferral[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogFor, setDialogFor] = useState<BankReferral | 'new' | null>(null)
  const [busySlug, setBusySlug] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/crm/bank-referrals')
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'load failed')
      setReferrals(json.referrals ?? [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load bank referrals')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const patch = async (slug: string, body: Record<string, unknown>) => {
    setBusySlug(slug)
    try {
      const res = await fetch(`/api/crm/bank-referrals/${slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      // R099 — surface the server's actual reason, never a generic failure.
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Update failed — please try again.')
      }
      await load()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Update failed — please try again.')
    } finally {
      setBusySlug(null)
    }
  }

  /**
   * Swap this bank's display position with its neighbour. Both rows are
   * written because sort_order is absolute, not relative — moving one without
   * the other would leave two banks fighting for the same slot.
   */
  const move = async (index: number, direction: -1 | 1) => {
    const a = referrals[index]
    const b = referrals[index + direction]
    if (!a || !b) return
    setBusySlug(a.slug)
    try {
      const responses = await Promise.all([
        fetch(`/api/crm/bank-referrals/${a.slug}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sort_order: b.sort_order }),
        }),
        fetch(`/api/crm/bank-referrals/${b.slug}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sort_order: a.sort_order }),
        }),
      ])
      const failed = responses.find(r => !r.ok)
      if (failed) {
        const d = await failed.json().catch(() => ({}))
        throw new Error(d.error || 'Reorder failed — please try again.')
      }
      await load()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Reorder failed — please try again.')
    } finally {
      setBusySlug(null)
    }
  }

  const remove = async (slug: string, label: string) => {
    if (!confirm(`Remove "${label}"? Clients will no longer see this bank on their portal.`)) return
    setBusySlug(slug)
    try {
      const res = await fetch(`/api/crm/bank-referrals/${slug}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Delete failed — please try again.')
      if (json.disabled) toast.info('Disabled (has click history — kept for reporting)')
      else toast.success('Removed')
      await load()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Delete failed — please try again.')
    } finally {
      setBusySlug(null)
    }
  }

  return (
    <div className="mt-6 bg-white rounded-lg border p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-base font-semibold">Bank Applications</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            The banks clients see on their portal, in this order. External banks are click-tracked;
            &ldquo;we submit for you&rdquo; banks open our own intake form instead.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDialogFor('new')}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700"
        >
          <Plus className="h-3.5 w-3.5" /> Add Bank
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : referrals.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">No banks yet. Click &quot;Add Bank&quot; to add one.</p>
      ) : (
        <div className="divide-y">
          {referrals.map((r, i) => (
            <div key={r.slug} className="flex items-start gap-2 py-2.5">
              <div className="flex flex-col shrink-0 pt-0.5">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0 || busySlug === r.slug}
                  className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30"
                  title="Move up"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === referrals.length - 1 || busySlug === r.slug}
                  className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30"
                  title="Move down"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-sm">{r.label}</span>
                  {r.tag && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-600">{r.tag}</span>
                  )}
                  {r.managed && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 font-semibold">
                      We submit for you
                    </span>
                  )}
                  {!r.enabled && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">Disabled</span>
                  )}
                </div>
                {r.managed ? (
                  <p className="text-xs text-zinc-500 truncate">{r.apply_url}</p>
                ) : (
                  <a
                    href={r.apply_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-zinc-500 hover:text-blue-600 inline-flex items-center gap-1 truncate max-w-full"
                  >
                    <span className="truncate">{r.apply_url}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                )}
                {r.rep_email && <p className="text-xs text-zinc-400 mt-0.5">Rep: {r.rep_email}</p>}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => patch(r.slug, { enabled: !r.enabled })}
                  disabled={busySlug === r.slug}
                  className={`text-xs px-2 py-1 rounded-md border ${r.enabled ? 'border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50'}`}
                >
                  {r.enabled ? <Check className="h-3 w-3" /> : 'Off'}
                </button>
                <button
                  type="button"
                  onClick={() => setDialogFor(r)}
                  disabled={busySlug === r.slug}
                  className="text-zinc-400 hover:text-blue-600 p-1"
                  title="Edit"
                >
                  <Pencil className="h-4 w-4" />
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
            </div>
          ))}
        </div>
      )}

      {dialogFor && (
        <BankDialog
          existing={dialogFor === 'new' ? null : dialogFor}
          onClose={() => setDialogFor(null)}
          onSaved={async () => { setDialogFor(null); await load() }}
        />
      )}
    </div>
  )
}

function BankDialog({
  existing,
  onClose,
  onSaved,
}: {
  existing: BankReferral | null
  onClose: () => void
  onSaved: () => void
}) {
  const [label, setLabel] = useState(existing?.label ?? '')
  const [applyUrl, setApplyUrl] = useState(existing?.apply_url ?? '')
  const [managed, setManaged] = useState(existing?.managed ?? false)
  const [tag, setTag] = useState(existing?.tag ?? '')
  const [descEn, setDescEn] = useState(existing?.description_en ?? '')
  const [descIt, setDescIt] = useState(existing?.description_it ?? '')
  const [repEmail, setRepEmail] = useState(existing?.rep_email ?? '')
  // Antonio works from the phone — keep the required pair visible and tuck the
  // rest away so the dialog isn't a wall of inputs at ~380px.
  const [showMore, setShowMore] = useState(false)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!label.trim() || !applyUrl.trim()) {
      toast.error('Bank name and link are required')
      return
    }
    setSaving(true)
    try {
      const payload = {
        label: label.trim(),
        apply_url: applyUrl.trim(),
        managed,
        tag: tag.trim() || null,
        description_en: descEn.trim() || null,
        description_it: descIt.trim() || null,
        rep_email: repEmail.trim() || null,
      }
      const res = existing
        ? await fetch(`/api/crm/bank-referrals/${existing.slug}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch('/api/crm/bank-referrals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
      // R099 — the server explains WHY (bad link shape, duplicate slug); show it.
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Save failed — please try again.')
      }
      toast.success(existing ? `Updated ${label.trim()}` : `Added ${label.trim()}`)
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Save failed — please try again.')
    } finally {
      setSaving(false)
    }
  }

  const inputClass =
    'w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500'

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-lg p-5 w-full max-w-md max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-4">{existing ? `Edit ${existing.label}` : 'Add Bank'}</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Bank name</label>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. Revolut"
              className={inputClass}
              autoFocus
            />
          </div>

          <label className="flex items-start gap-2 rounded-md border p-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={managed}
              onChange={e => setManaged(e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-sm">
              We submit for you
              <span className="block text-xs text-muted-foreground mt-0.5">
                The client fills in our own form and we file the application (Relay, Payset). Leave
                unticked for banks the client applies to directly.
              </span>
            </span>
          </label>

          <div>
            <label className="block text-sm font-medium mb-1">
              {managed ? 'Internal form path' : 'Apply link'}
            </label>
            <input
              type="text"
              value={applyUrl}
              onChange={e => setApplyUrl(e.target.value)}
              placeholder={managed ? '/portal/wizard?type=banking_relay' : 'https://…'}
              className={inputClass}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {managed
                ? 'Our own intake form — must start with /'
                : 'Where the client is sent. Include your partner/referral code. Clicks are tracked.'}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setShowMore(v => !v)}
            className="text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            {showMore ? 'Hide' : 'Show'} description, currency label and rep email
          </button>

          {showMore && (
            <div className="space-y-3 border-t pt-3">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Currency label <span className="text-zinc-400 font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  value={tag}
                  onChange={e => setTag(e.target.value)}
                  placeholder="e.g. USD or Multi-currency"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  Description — English <span className="text-zinc-400 font-normal">(optional)</span>
                </label>
                <textarea
                  value={descEn}
                  onChange={e => setDescEn(e.target.value)}
                  rows={2}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  Description — Italian <span className="text-zinc-400 font-normal">(optional)</span>
                </label>
                <textarea
                  value={descIt}
                  onChange={e => setDescIt(e.target.value)}
                  rows={2}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  Rep email <span className="text-zinc-400 font-normal">(optional)</span>
                </label>
                <input
                  type="email"
                  value={repEmail}
                  onChange={e => setRepEmail(e.target.value)}
                  placeholder="rep@bank.com"
                  className={inputClass}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Emailed the first time each client clicks this bank. Not used for &ldquo;we submit
                  for you&rdquo; banks.
                </p>
              </div>
            </div>
          )}
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
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {existing ? 'Save' : 'Add Bank'}
          </button>
        </div>
      </div>
    </div>
  )
}
