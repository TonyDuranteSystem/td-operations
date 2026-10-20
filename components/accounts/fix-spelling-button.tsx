'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { SpellCheck, Check, X, Loader2 } from 'lucide-react'
import { fixAccountNameSpelling } from '@/app/(dashboard)/accounts/actions'

/**
 * "Fix spelling" beside a company's name — the only way to edit the name by hand (the pen is locked). Type the right name: the company
 * AND its storage folder are renamed to match. No previous name is recorded.
 */
export function FixSpellingButton({ accountId, currentName }: { accountId: string; currentName: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(currentName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    const result = await fixAccountNameSpelling(accountId, draft)
    setSaving(false)
    if (!result.success) {
      setError(result.error ?? 'Could not fix the name.')
      return
    }
    toast.success('Spelling corrected')
    setOpen(false)
    router.refresh()
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { setDraft(currentName); setError(null); setOpen(true) }}
        className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
      >
        <SpellCheck className="h-3 w-3" /> Fix spelling
      </button>
    )
  }

  return (
    <div className="w-full space-y-1">
      <div className="flex items-center gap-1">
        <input
          id={`fix-spelling-${accountId}`}
          aria-label="Corrected company name"
          autoFocus
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setError(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setOpen(false) }}
          className="min-w-[16rem] flex-1 rounded-md border border-zinc-300 px-2 py-1 text-sm"
        />
        <button type="button" onClick={() => void save()} disabled={saving} className="rounded bg-emerald-50 p-1.5 text-emerald-600 hover:bg-emerald-100 disabled:opacity-50" aria-label="Save the corrected name">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={saving} className="rounded bg-zinc-50 p-1.5 text-zinc-500 hover:bg-zinc-100" aria-label="Cancel">
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="text-xs text-zinc-500">Type the right name. The storage folder is renamed to match.</p>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}
