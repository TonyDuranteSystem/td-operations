'use client'

/**
 * LinkClientDialog — attach the open Gmail thread to a CRM client
 * (Antonio 2026-07-08: link ShipStation/Mercury-style notifications to the
 * client they're about). Linked threads appear in the client's email views
 * (Portal Chats Email tab + account page Emails tab) with a "Linked" badge.
 */

import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Building2, Link2, Loader2, Search, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import type { InboxConversation } from '@/lib/types'

interface LinkRow {
  id: string
  account_id: string | null
  contact_id: string | null
  account?: { company_name?: string } | null
  linked_by: string | null
}

interface SearchAccount {
  id: string
  company_name: string
}

interface LinkClientDialogProps {
  conversation: InboxConversation
  mailbox?: string
  onClose: () => void
}

export function LinkClientDialog({ conversation, mailbox, onClose }: LinkClientDialogProps) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<SearchAccount[]>([])
  const [searching, setSearching] = useState(false)
  const queryClient = useQueryClient()

  const gmailThreadId = conversation.id.replace('gmail:', '')
  const mailboxKey = mailbox === 'antonio' ? 'antonio' : 'support'

  const { data: linksData, refetch } = useQuery<{ links: LinkRow[] }>({
    queryKey: ['email-links', gmailThreadId, mailboxKey],
    queryFn: () =>
      fetch(`/api/inbox/email-links?thread_id=${encodeURIComponent(gmailThreadId)}&mailbox=${mailboxKey}`)
        .then(r => r.json()),
  })
  const links = linksData?.links ?? []

  // Debounced account search via the existing inbox contacts-search endpoint
  useEffect(() => {
    const q = search.trim()
    if (q.length < 2) { setResults([]); return }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/inbox/contacts-search?q=${encodeURIComponent(q)}`)
        const data = await res.json()
        // Flatten unique accounts out of the contact results
        const seen = new Map<string, SearchAccount>()
        for (const c of data.contacts ?? []) {
          for (const link of c.account_contacts ?? []) {
            const acct = link.accounts
            if (acct?.id && !seen.has(acct.id)) {
              seen.set(acct.id, { id: acct.id, company_name: acct.company_name })
            }
          }
        }
        setResults(Array.from(seen.values()).slice(0, 8))
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  const linkMutation = useMutation({
    mutationFn: async (account: SearchAccount) => {
      const res = await fetch('/api/inbox/email-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gmailThreadId,
          mailbox: mailboxKey,
          accountId: account.id,
          subject: conversation.subject,
          sender: conversation.name,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Link failed — please try again.')
      return account
    },
    onSuccess: (account) => {
      toast.success(`Linked to ${account.company_name}`)
      setSearch('')
      setResults([])
      refetch()
      queryClient.invalidateQueries({ queryKey: ['client-emails'] })
    },
    onError: (err) =>
      toast.error(err instanceof Error && err.message ? err.message : 'Link failed — please try again.'),
  })

  const unlinkMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch('/api/inbox/email-links', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Unlink failed — please try again.')
    },
    onSuccess: () => {
      toast.success('Link removed')
      refetch()
      queryClient.invalidateQueries({ queryKey: ['client-emails'] })
    },
    onError: (err) =>
      toast.error(err instanceof Error && err.message ? err.message : 'Unlink failed — please try again.'),
  })

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <div className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[92vw] bg-white rounded-xl shadow-2xl border border-zinc-200">
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          <Link2 className="h-4 w-4 text-blue-500 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-zinc-900">Link email to client</p>
            <p className="text-xs text-zinc-500 truncate">{conversation.subject || conversation.name}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100 text-zinc-400">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {links.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">Linked to</p>
              {links.map(l => (
                <div key={l.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-blue-50 text-sm">
                  <Building2 className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                  <span className="flex-1 truncate text-zinc-800">
                    {l.account?.company_name || l.account_id || l.contact_id}
                  </span>
                  <button
                    onClick={() => unlinkMutation.mutate(l.id)}
                    disabled={unlinkMutation.isPending}
                    className="p-1 rounded hover:bg-red-100 text-zinc-400 hover:text-red-600"
                    title="Remove link"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 border rounded-lg px-3 py-2">
            <Search className="h-4 w-4 text-zinc-400 shrink-0" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search client / company…"
              autoFocus
              className="flex-1 text-sm outline-none placeholder:text-zinc-400"
            />
            {searching && <Loader2 className="h-4 w-4 animate-spin text-zinc-300" />}
          </div>

          <div className="max-h-56 overflow-y-auto space-y-0.5">
            {results.map(a => (
              <button
                key={a.id}
                onClick={() => linkMutation.mutate(a)}
                disabled={linkMutation.isPending}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-zinc-50 text-left text-sm"
              >
                <Building2 className="h-4 w-4 text-zinc-400 shrink-0" />
                <span className="flex-1 truncate">{a.company_name}</span>
                <Link2 className="h-3.5 w-3.5 text-blue-400 shrink-0" />
              </button>
            ))}
            {search.trim().length >= 2 && !searching && results.length === 0 && (
              <p className="text-xs text-zinc-400 px-2 py-2">No clients found</p>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
