'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Pencil, ArchiveX, Loader2, X, Star, Package } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TdCommPackage, PackagePaymentTiming } from '@/lib/td-communication/types'

interface FormState {
  slug: string
  name_en: string
  name_it: string
  description_en: string
  description_it: string
  price_usd: string
  delivery_days: string
  max_revisions: string
  payment_timing: PackagePaymentTiming
  highlighted: boolean
  active: boolean
  sort_order: string
  includesText: string // one item per line
  upsell_from: string[]
}

function toForm(p: TdCommPackage): FormState {
  return {
    slug: p.slug,
    name_en: p.name_en,
    name_it: p.name_it ?? '',
    description_en: p.description_en ?? '',
    description_it: p.description_it ?? '',
    price_usd: p.price_usd === null ? '' : String(p.price_usd),
    delivery_days: p.delivery_days === null ? '' : String(p.delivery_days),
    max_revisions: String(p.max_revisions),
    payment_timing: p.payment_timing,
    highlighted: p.highlighted,
    active: p.active,
    sort_order: String(p.sort_order),
    includesText: p.includes.join('\n'),
    upsell_from: p.upsell_from,
  }
}

const EMPTY_FORM: FormState = {
  slug: '', name_en: '', name_it: '', description_en: '', description_it: '',
  price_usd: '', delivery_days: '', max_revisions: '2', payment_timing: 'on_approval',
  highlighted: false, active: true, sort_order: '0', includesText: '', upsell_from: [],
}

/** Build the API payload from form state (numbers parsed, includes split). */
function toPayload(f: FormState, isCreate: boolean) {
  const includes = f.includesText.split('\n').map((s) => s.trim()).filter(Boolean)
  const num = (v: string): number | null => (v.trim() === '' ? null : Number(v))
  return {
    ...(isCreate ? { slug: f.slug.trim() } : {}),
    name_en: f.name_en.trim(),
    name_it: f.name_it.trim() || null,
    description_en: f.description_en.trim() || null,
    description_it: f.description_it.trim() || null,
    price_usd: num(f.price_usd),
    delivery_days: num(f.delivery_days),
    max_revisions: Number(f.max_revisions || '0'),
    payment_timing: f.payment_timing,
    highlighted: f.highlighted,
    active: f.active,
    sort_order: Number(f.sort_order || '0'),
    includes,
    upsell_from: f.upsell_from,
  }
}

export function PackagesAdmin({ isAdmin }: { isAdmin: boolean }) {
  const [packages, setPackages] = useState<TdCommPackage[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<TdCommPackage | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/td-communication/admin/packages')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load packages.')
      }
      const data = await res.json()
      setPackages(Array.isArray(data.packages) ? data.packages : [])
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to load packages.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const otherSlugs = useMemo(
    () => packages.map((p) => p.slug).filter((s) => s !== editing?.slug),
    [packages, editing],
  )

  async function softDelete(p: TdCommPackage) {
    if (!confirm(`Retire package "${p.name_en}"? It will be hidden from active lists (existing projects keep their label).`)) return
    try {
      const res = await fetch(`/api/td-communication/admin/packages/${encodeURIComponent(p.slug)}`, { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to retire package.')
      }
      toast.success('Package retired.')
      void load()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to retire package.')
    }
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <p className="text-sm text-zinc-500">Branding packages clients can buy. Retired packages stay hidden but keep existing projects labeled.</p>
        {isAdmin && (
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded font-medium px-3 py-1.5"
          >
            <Plus className="w-4 h-4" /> Add package
          </button>
        )}
      </div>

      {packages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center">
          <div>
            <Package className="h-10 w-10 text-zinc-300 mx-auto mb-3" />
            <p className="text-sm text-zinc-500">No packages yet.</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto border rounded-lg bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide sticky top-0">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Name</th>
                <th className="text-left px-3 py-2 font-medium">Price</th>
                <th className="text-left px-3 py-2 font-medium">Delivery</th>
                <th className="text-left px-3 py-2 font-medium">Revisions</th>
                <th className="text-left px-3 py-2 font-medium">Payment</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                {isAdmin && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {packages.map((p) => (
                <tr key={p.slug} className={cn('hover:bg-gray-50', !p.active && 'opacity-50')}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-zinc-900">{p.name_en}</span>
                      {p.highlighted && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                          <Star className="w-3 h-3" /> Most Popular
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-zinc-400">{p.slug}</span>
                  </td>
                  <td className="px-3 py-2 text-zinc-700">{p.price_usd === null ? '—' : `$${p.price_usd.toLocaleString()}`}</td>
                  <td className="px-3 py-2 text-zinc-700">{p.delivery_days === null ? '—' : `${p.delivery_days}d`}</td>
                  <td className="px-3 py-2 text-zinc-700">{p.max_revisions}</td>
                  <td className="px-3 py-2 text-zinc-700">{p.payment_timing === 'upfront' ? 'Upfront' : 'On approval'}</td>
                  <td className="px-3 py-2">
                    <span className={cn('inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
                      p.active ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600')}>
                      {p.active ? 'Active' : 'Retired'}
                    </span>
                  </td>
                  {isAdmin && (
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button onClick={() => setEditing(p)} className="text-zinc-500 hover:text-blue-700 p-1" title="Edit">
                        <Pencil className="w-4 h-4" />
                      </button>
                      {p.active && (
                        <button onClick={() => softDelete(p)} className="text-zinc-500 hover:text-red-700 p-1" title="Retire">
                          <ArchiveX className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <PackageModal
          title="Add package"
          initial={EMPTY_FORM}
          isCreate
          otherSlugs={packages.map((p) => p.slug)}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); void load() }}
        />
      )}
      {editing && (
        <PackageModal
          title={`Edit “${editing.name_en}”`}
          initial={toForm(editing)}
          isCreate={false}
          slug={editing.slug}
          otherSlugs={otherSlugs}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load() }}
        />
      )}
    </div>
  )
}

function PackageModal({
  title, initial, isCreate, slug, otherSlugs, onClose, onSaved,
}: {
  title: string
  initial: FormState
  isCreate: boolean
  slug?: string
  otherSlugs: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(initial)
  const [busy, setBusy] = useState(false)

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function submit() {
    setBusy(true)
    try {
      const url = isCreate
        ? '/api/td-communication/admin/packages'
        : `/api/td-communication/admin/packages/${encodeURIComponent(slug!)}`
      const res = await fetch(url, {
        method: isCreate ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toPayload(form, isCreate)),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to save package.')
      }
      toast.success(isCreate ? 'Package created.' : 'Package updated.')
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to save package.')
    } finally {
      setBusy(false)
    }
  }

  const label = 'block text-xs font-medium text-gray-700 mb-1'
  const input = 'w-full border rounded px-2 py-1.5 text-sm'

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-3 border-b sticky top-0 bg-white">
          <h3 className="font-semibold">{title}</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          {isCreate ? (
            <label className="block">
              <span className={label}>Slug *</span>
              <input className={input} value={form.slug} onChange={(e) => set('slug', e.target.value)} placeholder="logo-landing" />
              <span className="text-[11px] text-zinc-400">Lowercase, hyphens. Cannot be changed later.</span>
            </label>
          ) : (
            <div>
              <span className={label}>Slug</span>
              <div className="text-sm text-zinc-500">{slug} <span className="text-[11px]">(immutable)</span></div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className={label}>Name (EN) *</span>
              <input className={input} value={form.name_en} onChange={(e) => set('name_en', e.target.value)} /></label>
            <label className="block"><span className={label}>Name (IT)</span>
              <input className={input} value={form.name_it} onChange={(e) => set('name_it', e.target.value)} /></label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className={label}>Description (EN)</span>
              <textarea className={input} rows={2} value={form.description_en} onChange={(e) => set('description_en', e.target.value)} /></label>
            <label className="block"><span className={label}>Description (IT)</span>
              <textarea className={input} rows={2} value={form.description_it} onChange={(e) => set('description_it', e.target.value)} /></label>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <label className="block"><span className={label}>Price (USD)</span>
              <input className={input} type="number" min="0" value={form.price_usd} onChange={(e) => set('price_usd', e.target.value)} /></label>
            <label className="block"><span className={label}>Delivery days</span>
              <input className={input} type="number" min="0" value={form.delivery_days} onChange={(e) => set('delivery_days', e.target.value)} /></label>
            <label className="block"><span className={label}>Max revisions</span>
              <input className={input} type="number" min="0" value={form.max_revisions} onChange={(e) => set('max_revisions', e.target.value)} /></label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className={label}>Payment timing</span>
              <select className={input} value={form.payment_timing} onChange={(e) => set('payment_timing', e.target.value as PackagePaymentTiming)}>
                <option value="on_approval">On approval</option>
                <option value="upfront">Upfront</option>
              </select></label>
            <label className="block"><span className={label}>Sort order</span>
              <input className={input} type="number" value={form.sort_order} onChange={(e) => set('sort_order', e.target.value)} /></label>
          </div>

          <label className="block"><span className={label}>Includes (one per line)</span>
            <textarea className={input} rows={3} value={form.includesText} onChange={(e) => set('includesText', e.target.value)} placeholder={'Custom logo design\nFinal files (PNG, SVG, PDF)'} /></label>

          {otherSlugs.length > 0 && (
            <div>
              <span className={label}>Upsell from</span>
              <div className="flex flex-wrap gap-2">
                {otherSlugs.map((s) => {
                  const checked = form.upsell_from.includes(s)
                  return (
                    <button key={s} type="button"
                      onClick={() => set('upsell_from', checked ? form.upsell_from.filter((x) => x !== s) : [...form.upsell_from, s])}
                      className={cn('px-2 py-0.5 rounded text-xs border', checked ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50')}>
                      {s}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <div className="flex items-center gap-4 pt-1">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={form.highlighted} onChange={(e) => set('highlighted', e.target.checked)} /> Most Popular
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} /> Active
            </label>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t sticky bottom-0 bg-white">
          <button onClick={onClose} className="border text-gray-700 hover:bg-gray-50 text-sm rounded font-medium px-3 py-1.5">Cancel</button>
          <button onClick={submit} disabled={busy} className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded font-medium px-3 py-1.5">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Save
          </button>
        </div>
      </div>
    </div>
  )
}
