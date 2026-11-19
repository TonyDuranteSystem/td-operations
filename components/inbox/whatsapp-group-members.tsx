'use client'

import { useQuery } from '@tanstack/react-query'
import { Loader2, ShieldCheck, Users, X } from 'lucide-react'
import { createPortal } from 'react-dom'

interface MemberRow {
  phone: string | null
  name: string | null
  admin: boolean
  crm: { kind: 'contact' | 'lead'; id: string; name: string } | null
}

/** "+" and the digits, grouped loosely — good enough to read and to match against the phone. */
function showPhone(p: string | null): string {
  return p ? `+${p}` : 'Number hidden by WhatsApp'
}

/**
 * "Who is in this group": the members the phone reported, each with name, number and an Admin tag, and — when exactly one CRM
 * lead/contact holds that exact number — who they are in the CRM. A centred window (not a dropdown) so no scrolling box can clip it.
 */
export function WhatsAppGroupMembersDialog({ groupId, groupName, onClose }: { groupId: string; groupName: string; onClose: () => void }) {
  const { data, isLoading, error } = useQuery<{ available: boolean; reported?: boolean; members: MemberRow[] }>({
    queryKey: ['whatsapp-group-members', groupId],
    queryFn: () => fetch(`/api/inbox/whatsapp/members/${encodeURIComponent(groupId)}`).then((r) => r.json()),
    staleTime: 60_000,
  })
  const members = data?.members ?? []

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose} data-testid="wa-members-dialog">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Users className="h-4 w-4 text-zinc-500" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-zinc-900">{groupName}</p>
            <p className="text-xs text-zinc-500">{isLoading ? 'Loading…' : `${members.length} member${members.length === 1 ? '' : 's'}`}</p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto p-2">
          {isLoading && <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-zinc-400" /></div>}
          {!isLoading && (error || data?.available === false) && (
            <p className="p-4 text-sm text-zinc-500">The member list is not available yet.</p>
          )}
          {!isLoading && !error && data?.available !== false && data?.reported === false && (
            <p className="p-4 text-sm text-zinc-500">The member list has not arrived from the phone yet — it appears within a minute.</p>
          )}
          {members.map((m, i) => (
            <div key={`${m.phone ?? 'x'}-${i}`} className="flex items-start gap-3 rounded-lg px-3 py-2 hover:bg-zinc-50" data-testid="wa-member-row">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600">
                {(m.crm?.name ?? m.name ?? '?').trim().charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-sm font-medium text-zinc-900">
                  <span className="truncate">{m.crm?.name ?? m.name ?? 'Unknown'}</span>
                  {m.admin && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                      <ShieldCheck className="h-3 w-3" /> Admin
                    </span>
                  )}
                </p>
                <p className="text-xs text-zinc-500">
                  {showPhone(m.phone)}
                  {m.crm && m.name && m.name !== m.crm.name ? ` · WhatsApp name: ${m.name}` : ''}
                </p>
                {m.crm && (
                  <span className="mt-0.5 inline-block rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                    {m.crm.kind === 'contact' ? 'In the CRM (contact)' : 'In the CRM (lead)'}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
