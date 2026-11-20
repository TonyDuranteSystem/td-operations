'use client'

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Loader2, Search, X } from 'lucide-react'
import { toast } from 'sonner'

interface LinkState { isGroup: boolean; accountId: string | null; accountName: string | null }
interface AccountHit { type: string; id: string; name: string }

/**
 * A WhatsApp GROUP's company. A group has many people, so it is linked to a COMPANY (not a person): once linked, the chat's
 * "Create task / service / invoice", team discussion and notes attach to that company. Shown only for group chats.
 */
export function WhatsAppGroupCompanyBar({ groupId }: { groupId: string }) {
  const qc = useQueryClient()
  const { data } = useQuery<LinkState>({
    queryKey: ['wa-group-link', groupId],
    queryFn: () => fetch(`/api/inbox/whatsapp/group-link?groupId=${encodeURIComponent(groupId)}`).then((r) => r.json()),
    staleTime: 30_000,
  })
  const [picking, setPicking] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<AccountHit[]>([])
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!picking || q.trim().length < 2) { setHits([]); return }
    const h = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/accounts/search-for-feed-match?q=${encodeURIComponent(q.trim())}`)
        const json = await res.json()
        setHits((json.results ?? []).filter((r: AccountHit) => r.type === 'account'))
      } catch { setHits([]) } finally { setSearching(false) }
    }, 250)
    return () => clearTimeout(h)
  }, [q, picking])

  if (!data?.isGroup) return null

  const save = async (accountId: string | null) => {
    setSaving(true)
    try {
      const res = await fetch('/api/inbox/whatsapp/group-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId, accountId }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not save the link — please try again.')
      setPicking(false); setQ(''); setHits([])
      await qc.invalidateQueries({ queryKey: ['wa-group-link', groupId] })
      qc.invalidateQueries({ queryKey: ['whatsapp-messages', groupId] }) // the message menu reads the company from here
      qc.invalidateQueries({ queryKey: ['inbox-conversations'] })
      toast.success(accountId ? 'Group linked to the company.' : 'Group unlinked.')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not save the link — please try again.')
    } finally { setSaving(false) }
  }

  return (
    <div className="border-b bg-white px-3 py-1.5 text-xs" data-testid="wa-group-company-bar">
      <div className="flex flex-wrap items-center gap-2">
        <Building2 className="h-3.5 w-3.5 text-zinc-400" />
        {data.accountId ? (
          <span className="text-zinc-700">Company: <span className="font-medium">{data.accountName ?? 'linked'}</span></span>
        ) : (
          <span className="text-zinc-500">This group is not linked to a company.</span>
        )}
        {!picking && (
          <button onClick={() => setPicking(true)} className="rounded px-1.5 py-0.5 font-medium text-blue-600 hover:bg-blue-50" data-testid="wa-group-company-change">
            {data.accountId ? 'Change' : 'Link to a company'}
          </button>
        )}
        {!picking && data.accountId && (
          <button onClick={() => save(null)} disabled={saving} className="rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-100 disabled:opacity-50">Unlink</button>
        )}
      </div>
      {picking && (
        <div className="mt-1.5">
          <div className="flex items-center gap-1.5 rounded border border-zinc-200 px-2 py-1">
            <Search className="h-3.5 w-3.5 text-zinc-400" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a company…" className="flex-1 bg-transparent outline-none placeholder:text-zinc-400" data-testid="wa-group-company-search" />
            {(searching || saving) && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
            <button onClick={() => { setPicking(false); setQ(''); setHits([]) }} className="text-zinc-400 hover:text-zinc-700" aria-label="Cancel"><X className="h-3.5 w-3.5" /></button>
          </div>
          {hits.length > 0 && (
            <div className="mt-1 max-h-40 overflow-y-auto rounded border border-zinc-200 bg-white">
              {hits.map((h) => (
                <button key={h.id} onClick={() => save(h.id)} disabled={saving} className="block w-full px-2 py-1.5 text-left hover:bg-zinc-50 disabled:opacity-50" data-testid="wa-group-company-hit">{h.name}</button>
              ))}
            </div>
          )}
          {q.trim().length >= 2 && !searching && hits.length === 0 && <p className="mt-1 px-1 text-zinc-400">No company found.</p>}
        </div>
      )}
    </div>
  )
}
