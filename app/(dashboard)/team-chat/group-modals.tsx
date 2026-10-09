'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { TeamMember } from './types'

/** Group chat dialogs for the CRM Team Chat page (dev job c1e326dd). Same routes as TD Talk: /api/team/groups. */

async function errorOf(r: Response, fallback: string): Promise<string> {
  const d = await r.json().catch(() => ({}))
  return d.error || fallback
}

export function NewGroupModal({ members, onClose, onCreated }: {
  members: TeamMember[]; onClose: () => void; onCreated: (threadId: string) => void
}) {
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const toggle = (id: string) => setPicked(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const create = async () => {
    setBusy(true)
    try {
      const r = await fetch('/api/team/groups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, member_ids: Array.from(picked) }),
      })
      if (!r.ok) throw new Error(await errorOf(r, 'Could not create the group.'))
      const d = await r.json()
      onCreated(d.thread.id)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not create the group.')
    } finally { setBusy(false) }
  }
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-5 w-96" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-900 mb-3">New group</h3>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Group name" maxLength={80}
          className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm mb-3" />
        <p className="text-[11px] text-zinc-500 mb-1">Pick at least two people ({picked.size} chosen)</p>
        <div className="flex flex-col gap-1 max-h-64 overflow-y-auto mb-3">
          {members.map(m => (
            <label key={m.id} className={cn('flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer hover:bg-zinc-100', picked.has(m.id) && 'bg-zinc-100')}>
              <input type="checkbox" checked={picked.has(m.id)} onChange={() => toggle(m.id)} />
              <span className="text-sm text-zinc-800">{m.name}</span>
              <span className="text-[10px] text-zinc-400 capitalize">{m.role}</span>
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg hover:bg-zinc-100">Cancel</button>
          <button onClick={create} disabled={busy || !name.trim() || picked.size < 2}
            className="px-3 py-1.5 text-sm rounded-lg bg-zinc-900 text-white disabled:opacity-40">Create group</button>
        </div>
      </div>
    </div>
  )
}

export function GroupInfoModal({ threadId, title, members, currentUserId, onClose, onChanged, onLeft }: {
  threadId: string; title: string; members: TeamMember[]; currentUserId: string | null
  onClose: () => void; onChanged: () => void; onLeft: () => void
}) {
  const [memberIds, setMemberIds] = useState<string[] | null>(null)
  const [name, setName] = useState(title)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const r = await fetch(`/api/team/groups/${threadId}`)
    if (!r.ok) { toast.error(await errorOf(r, 'Could not load the group.')); return }
    const d = await r.json()
    setMemberIds(d.members as string[])
  }
  useEffect(() => { load() }, [threadId]) // eslint-disable-line react-hooks/exhaustive-deps

  const nameOf = (id: string) => members.find(m => m.id === id)?.name ?? 'Team member'
  const call = async (fn: () => Promise<Response>, fallback: string): Promise<boolean> => {
    setBusy(true)
    try {
      const r = await fn()
      if (!r.ok) throw new Error(await errorOf(r, fallback))
      return true
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : fallback)
      return false
    } finally { setBusy(false) }
  }
  const rename = async () => {
    if (!name.trim() || name.trim() === title) return
    if (await call(() => fetch(`/api/team/groups/${threadId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }), 'Could not rename the group.')) onChanged()
  }
  const add = async (id: string) => {
    if (await call(() => fetch(`/api/team/groups/${threadId}/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_ids: [id] }) }), 'Could not add that person.')) { await load(); onChanged() }
  }
  const leave = async () => {
    if (!window.confirm('Leave this group? You will stop receiving its messages.')) return
    if (await call(() => fetch(`/api/team/groups/${threadId}/members`, { method: 'DELETE' }), 'Could not leave the group.')) onLeft()
  }
  const candidates = members.filter(m => m.id !== currentUserId && memberIds && !memberIds.includes(m.id))

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-5 w-96" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-900 mb-3">Group info</h3>
        <div className="flex gap-2 mb-4">
          <input value={name} onChange={e => setName(e.target.value)} maxLength={80} className="flex-1 border border-zinc-200 rounded-lg px-3 py-1.5 text-sm" />
          <button onClick={rename} disabled={busy || !name.trim() || name.trim() === title} className="px-3 py-1.5 text-sm rounded-lg bg-zinc-900 text-white disabled:opacity-40">Rename</button>
        </div>
        <p className="text-[11px] text-zinc-500 mb-1">Members{memberIds ? ` (${memberIds.length})` : ''}</p>
        <div className="flex flex-col mb-3 max-h-40 overflow-y-auto">
          {(memberIds ?? []).map(id => (
            <span key={id} className="px-2 py-1 text-sm text-zinc-800">{id === currentUserId ? 'You' : nameOf(id)}</span>
          ))}
        </div>
        {candidates.length > 0 && (
          <>
            <p className="text-[11px] text-zinc-500 mb-1">Add people</p>
            <div className="flex flex-col mb-3 max-h-32 overflow-y-auto">
              {candidates.map(m => (
                <button key={m.id} disabled={busy} onClick={() => add(m.id)} className="text-left px-2 py-1 text-sm rounded-lg hover:bg-zinc-100">+ {m.name}</button>
              ))}
            </div>
          </>
        )}
        <div className="flex justify-between">
          <button onClick={leave} disabled={busy} className="px-3 py-1.5 text-sm rounded-lg text-red-600 hover:bg-red-50">Leave group</button>
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg hover:bg-zinc-100">Close</button>
        </div>
      </div>
    </div>
  )
}
