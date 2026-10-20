'use client'

/**
 * The pop-up on Generate Documents (dev job d016d398, Antonio 2026-10-20): a multi-member company's Operating
 * Agreement needs every owner's details. The PRIMARY owner fills in what is missing (and may change the ownership
 * percentages — their legal fact), we save it to the company's records and the screen sends the agreement.
 * Already-filled details are shown but not editable here.
 */
import { useState } from 'react'
import { Loader2, CheckCircle2, X } from 'lucide-react'
import type { MemberGapView, MissingField } from '@/lib/members/oa-member-gaps'

type Values = Record<string, string>

const FIELD_KEY: Record<MissingField, string> = {
  email: 'documentGenerate.md.email',
  address_street: 'documentGenerate.md.street',
  address_city: 'documentGenerate.md.city',
  address_country: 'documentGenerate.md.country',
  representative_name: 'documentGenerate.md.repName',
  representative_email: 'documentGenerate.md.repEmail',
}

interface Props {
  accountId: string
  companyName: string
  members: MemberGapView[]
  t: (key: string) => string
  onClose: () => void
  /** Called after the details are saved — the screen then sends the agreement. */
  onSaved: () => void
}

export function OaMembersDialog({ accountId, companyName, members, t, onClose, onSaved }: Props) {
  const [values, setValues] = useState<Record<string, Values>>(() => {
    const init: Record<string, Values> = {}
    for (const m of members) {
      init[m.id] = { ownership_pct: m.ownership_pct == null ? '' : String(m.ownership_pct) }
      for (const f of m.missing) init[m.id][f] = ''
    }
    return init
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const total = members.reduce((s, m) => s + (Number(values[m.id]?.ownership_pct) || 0), 0)
  const totalOk = Math.abs(total - 100) <= 0.01

  const set = (id: string, field: string, v: string) => setValues(prev => ({ ...prev, [id]: { ...prev[id], [field]: v } }))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/portal/operating-agreement/fix-members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          members: members.map(m => ({ id: m.id, ...values[m.id] })),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('documentGenerate.md.saveFailed'))
      onSaved()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('documentGenerate.md.saveFailed'))
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t('documentGenerate.md.title')}>
      <div className="absolute inset-0 bg-black/50" onClick={saving ? undefined : onClose} />
      <div className="relative w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-xl bg-white text-zinc-900 shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">{t('documentGenerate.md.title')}</h2>
            <p className="mt-0.5 text-sm text-zinc-600">{t('documentGenerate.md.intro')} <span className="font-medium">{companyName}</span></p>
          </div>
          <button onClick={onClose} disabled={saving} className="rounded p-1 text-zinc-400 hover:text-zinc-700" aria-label={t('documentGenerate.md.cancel')}>
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {members.map(m => {
            const v = values[m.id] ?? {}
            return (
              <div key={m.id} className="rounded-lg border border-zinc-200 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {m.missing.length === 0 && <CheckCircle2 size={15} className="text-green-600" />}
                    {m.name}
                    {m.missing.length === 0 && <span className="text-xs font-normal text-green-700">{t('documentGenerate.md.complete')}</span>}
                  </div>
                  <label className="flex items-center gap-1.5 text-xs text-zinc-600">
                    {t('documentGenerate.md.ownership')}
                    <input
                      type="number" min={0} max={100} step="0.01" inputMode="decimal"
                      value={v.ownership_pct ?? ''}
                      onChange={e => set(m.id, 'ownership_pct', e.target.value)}
                      className="w-20 rounded-md border border-zinc-300 px-2 py-1 text-right text-sm"
                    />
                  </label>
                </div>
                {m.missing.length > 0 && (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {m.missing.map(f => (
                      <label key={f} className={`text-xs text-zinc-600 ${f === 'email' || f === 'representative_email' || f === 'address_street' ? 'sm:col-span-2' : ''}`}>
                        {t(FIELD_KEY[f])} *
                        <input
                          type={f === 'email' || f === 'representative_email' ? 'email' : 'text'}
                          value={v[f] ?? ''}
                          onChange={e => set(m.id, f, e.target.value)}
                          className="mt-0.5 w-full rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm text-zinc-900"
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          <div className={`flex items-center justify-between rounded-md px-3 py-2 text-sm ${totalOk ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
            <span>{t('documentGenerate.md.total')}: {Math.round(total * 100) / 100}%</span>
            {!totalOk && <span>{t('documentGenerate.md.totalMust')}</span>}
          </div>
          <p className="text-xs text-zinc-500">{t('documentGenerate.md.signLinkNote')}</p>
          {error && <p className="text-sm text-red-600 leading-snug">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3">
          <button onClick={onClose} disabled={saving} className="rounded-lg border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50">{t('documentGenerate.md.cancel')}</button>
          <button onClick={save} disabled={saving || !totalOk} className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:bg-zinc-300">
            {saving && <Loader2 size={15} className="animate-spin" />}
            {saving ? t('documentGenerate.md.saving') : t('documentGenerate.md.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
