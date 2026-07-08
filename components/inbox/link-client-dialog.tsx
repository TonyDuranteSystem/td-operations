'use client'

/**
 * LinkClientDialog — attach the open Gmail thread to ANY CRM role
 * (Antonio 2026-07-08: accounts, contacts, leads, partners — "for every
 * role, flexible"). Linked threads appear in the client's email views
 * (Portal Chats Email tab + account page Emails tab) with a "Linked" badge.
 * ONE link per thread — linking again replaces the target.
 */

import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Building2, Link2, Loader2, Search, Trash2, User, UserPlus, Handshake, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { InboxConversation } from '@/lib/types'

type TargetType = 'account' | 'contact' | 'lead' | 'partner'

interface LinkTarget {
  type: TargetType
  id: string
  name: string
  detail?: string
}

interface LinkRow {
  id: string
  account_id: string | null
  contact_id: string | null
  lead_id: string | null
  partner_id: string | null
  account?: { company_name?: string } | null
  contact?: { full_name?: string } | null
  lead?: { full_name?: string } | null
  partner?: { partner_name?: string } | null
  linked_by: string | null
}

const TYPE_META: Record<TargetType, { label: string; icon: typeof Building2; cls: string }> = {
  account: { label: 'Company', icon: Building2, cls: 'bg-blue-100 text-blue-700' },
  contact: { label: 'Contact', icon: User, cls: 'bg-emerald-100 text-emerald-700' },
  lead: { label: 'Lead', icon: UserPlus, cls: 'bg-amber-100 text-amber-700' },
  partner: { label: 'Partner', icon: Handshake, cls: 'bg-purple-100 text-purple-700' },
}

function linkRowInfo(l: LinkRow): { type: TargetType; name: string } {
  if (l.account_id) return { type: 'account', name: l.account?.company_name || l.account_id }
  if (l.contact_id) return { type: 'contact', name: l.contact?.full_name || l.contact_id }
  if (l.lead_id) return { type: 'lead', name: l.lead?.full_name || l.lead_id }
  return { type: 'partner', name: l.partner?.partner_name || l.partner_id || '' }
}

interface LinkClientDialogProps {
  conversation: InboxConversation
  mailbox?: string
  onClose: () => void
}

export function LinkClientDialog({ conversation, mailbox, onClose }: LinkClientDialogProps) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<LinkTarget[]>([])
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

  // Debounced multi-role search (accounts, contacts, leads, partners)
  useEffect(() => {
    const q = search.trim()
    if (q.length < 2) { setResults([]); return }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/inbox/link-targets?q=${encodeURIComponent(q)}`)
        const data = await res.json()
        setResults(data.targets ?? [])
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  const linkMutation = useMutation({
    mutationFn: async (target: LinkTarget) => {
      const idField =
        target.type === 'account' ? 'accountId'
        : target.type === 'contact' ? 'contactId'
        : target.type === 'lead' ? 'leadId'
        : 'partnerId'
      const res = await fetch('/api/inbox/email-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gmailThreadId,
          mailbox: mailboxKey,
          [idField]: target.id,
          subject: conversation.subject,
          sender: conversation.name,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Link failed — please try again.')
      return target
    },
    onSuccess: (target) => {
      toast.success(`Linked to ${target.name} (${TYPE_META[target.type].label})`)
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
      <div className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[460px] max-w-[92vw] bg-white rounded-xl shadow-2xl border border-zinc-200">
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          <Link2 className="h-4 w-4 text-blue-500 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-zinc-900">Link email</p>
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
              {links.map(l => {
                const info = linkRowInfo(l)
                const meta = TYPE_META[info.type]
                const Icon = meta.icon
                return (
                  <div key={l.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-blue-50 text-sm">
                    <Icon className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                    <span className="flex-1 truncate text-zinc-800">{info.name}</span>
                    <span className={cn('text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded', meta.cls)}>
                      {meta.label}
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
                )
              })}
              <p className="text-[10px] text-zinc-400">Linking to someone else replaces the current link.</p>
            </div>
          )}

          <div className="flex items-center gap-2 border rounded-lg px-3 py-2">
            <Search className="h-4 w-4 text-zinc-400 shrink-0" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search company, contact, lead or partner…"
              autoFocus
              className="flex-1 text-sm outline-none placeholder:text-zinc-400"
            />
            {searching && <Loader2 className="h-4 w-4 animate-spin text-zinc-300" />}
          </div>

          <div className="max-h-60 overflow-y-auto space-y-0.5">
            {results.map(t => {
              const meta = TYPE_META[t.type]
              const Icon = meta.icon
              return (
                <button
                  key={`${t.type}-${t.id}`}
                  onClick={() => linkMutation.mutate(t)}
                  disabled={linkMutation.isPending}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-zinc-50 text-left text-sm"
                >
                  <Icon className="h-4 w-4 text-zinc-400 shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">{t.name}</span>
                    {t.detail && <span className="block text-[11px] text-zinc-400 truncate">{t.detail}</span>}
                  </span>
                  <span className={cn('text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded shrink-0', meta.cls)}>
                    {meta.label}
                  </span>
                </button>
              )
            })}
            {search.trim().length >= 2 && !searching && results.length === 0 && (
              <p className="text-xs text-zinc-400 px-2 py-2">Nothing found</p>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
