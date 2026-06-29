'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, ExternalLink } from 'lucide-react'
import type { TdCommSettings } from '@/lib/td-communication/types'

export function SettingsAdmin({ isAdmin }: { isAdmin: boolean }) {
  const [settings, setSettings] = useState<TdCommSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/td-communication/admin/settings')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load settings.')
      }
      const data = await res.json()
      setSettings(data.settings ?? null)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to load settings.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  function set<K extends keyof TdCommSettings>(k: K, v: TdCommSettings[K]) {
    setSettings((s) => (s ? { ...s, [k]: v } : s))
  }

  async function save() {
    if (!settings) return
    setSaving(true)
    try {
      const res = await fetch('/api/td-communication/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to save settings.')
      }
      const data = await res.json()
      setSettings(data.settings ?? settings)
      toast.success('Settings saved.')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to save settings.')
    } finally {
      setSaving(false)
    }
  }

  if (loading || !settings) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>
  }

  const label = 'block text-xs font-medium text-gray-700 mb-1'
  const input = 'w-full border rounded px-2 py-1.5 text-sm disabled:bg-gray-50 disabled:text-gray-500'
  const disabled = !isAdmin

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-2xl space-y-5">
        {!isAdmin && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            Read-only — only an admin can change these settings.
          </p>
        )}

        {/* Feature toggle */}
        <div className="border rounded-lg bg-white p-4">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-medium text-zinc-900">Client portal tab</span>
              <span className="block text-xs text-zinc-500">Show the TD Communication tab to active-tier portal clients.</span>
            </span>
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={settings.enabled}
              disabled={disabled}
              onChange={(e) => set('enabled', e.target.checked)}
            />
          </label>
        </div>

        {/* Disclaimer */}
        <div className="border rounded-lg bg-white p-4 space-y-3">
          <h4 className="text-sm font-medium text-zinc-900">Disclaimer text</h4>
          <label className="block"><span className={label}>English</span>
            <textarea className={input} rows={3} disabled={disabled} value={settings.disclaimer_en} onChange={(e) => set('disclaimer_en', e.target.value)} /></label>
          <label className="block"><span className={label}>Italian</span>
            <textarea className={input} rows={3} disabled={disabled} value={settings.disclaimer_it} onChange={(e) => set('disclaimer_it', e.target.value)} /></label>
        </div>

        {/* SLA */}
        <div className="border rounded-lg bg-white p-4">
          <label className="block max-w-xs"><span className={label}>Default SLA days</span>
            <input className={input} type="number" min="0" disabled={disabled} value={settings.default_sla_days}
              onChange={(e) => set('default_sla_days', Number(e.target.value || '0'))} /></label>
          <p className="text-[11px] text-zinc-400 mt-1">Fallback used when a package has no delivery days set.</p>
        </div>

        {/* Landing page editor (Phase 9) — lives in its own tab. */}
        <div className="border rounded-lg bg-white p-4">
          <h4 className="text-sm font-medium text-zinc-900 mb-1">Landing page content</h4>
          <span className="inline-flex items-center gap-1.5 text-sm text-zinc-500">
            <ExternalLink className="w-4 h-4" /> Edit the client landing page in the <strong className="font-medium">Landing Page</strong> tab.
          </span>
        </div>

        {isAdmin && (
          <div className="flex justify-end">
            <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded font-medium px-4 py-1.5">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />} Save settings
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
