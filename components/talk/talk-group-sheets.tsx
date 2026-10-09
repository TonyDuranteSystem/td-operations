'use client'

import { useState } from 'react'
import { Check, ChevronLeft, Loader2, LogOut, Pencil, UserPlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { initials, membersNotInGroup, type TalkMember } from '@/lib/talk/chat-model'
import { MAX_GROUP_NAME, MIN_GROUP_MEMBERS } from '@/lib/team/groups-rules'

const COLORS = ['bg-rose-500', 'bg-indigo-500', 'bg-emerald-600', 'bg-amber-600', 'bg-sky-600', 'bg-violet-600']
function colorFor(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}
function Dot({ name, id }: { name: string; id: string }) {
  return <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white', colorFor(id))}>{initials(name)}</span>
}

/**
 * "New group": pick the people, name the group, create. Everyone on the team is offered (nothing is hidden). At least two
 * other people are needed — for one person you just message them.
 */
export function TalkNewGroup({
  members, meId, creating, onBack, onCreate,
}: {
  members: TalkMember[]; meId: string; creating: boolean
  onBack: () => void
  onCreate: (name: string, memberIds: string[]) => void
}) {
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const others = members.filter(m => m.id !== meId)
  const toggle = (id: string) => setPicked(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])
  const ready = name.trim().length > 0 && picked.length + 1 >= MIN_GROUP_MEMBERS && !creating

  return (
    <div className="flex h-full flex-col bg-white" data-testid="talk-newgroup">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-2 py-2">
        <button type="button" onClick={onBack} aria-label="Back" className="flex h-10 w-10 items-center justify-center rounded-full text-zinc-700 active:bg-zinc-100">
          <ChevronLeft className="h-6 w-6" />
        </button>
        <h1 className="flex-1 text-[17px] font-semibold text-zinc-900">New group</h1>
        <button
          type="button"
          onClick={() => onCreate(name.trim(), picked)}
          disabled={!ready}
          data-testid="talk-group-create"
          className="rounded-full bg-[#BE1E2D] px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          {creating ? 'Creating…' : 'Create'}
        </button>
      </div>
      <div className="shrink-0 px-4 py-3">
        <input
          autoFocus
          value={name}
          maxLength={MAX_GROUP_NAME}
          onChange={e => setName(e.target.value)}
          placeholder="Group name"
          className="h-11 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 text-[16px] outline-none focus:border-zinc-300"
          data-testid="talk-group-name"
        />
        <p className="mt-2 text-xs text-zinc-400">Pick at least two people. You are added automatically.</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {others.map(m => {
          const on = picked.includes(m.id)
          return (
            <button key={m.id} type="button" onClick={() => toggle(m.id)} data-testid="talk-group-pick" className="flex w-full items-center gap-3 border-b border-zinc-100 px-4 py-3 text-left active:bg-zinc-50">
              <Dot name={m.name} id={m.id} />
              <span className="flex-1 truncate text-[16px] text-zinc-900">{m.name}</span>
              <span className={cn('flex h-6 w-6 items-center justify-center rounded-full border', on ? 'border-[#BE1E2D] bg-[#BE1E2D] text-white' : 'border-zinc-300')}>
                {on && <Check className="h-4 w-4" />}
              </span>
            </button>
          )
        })}
        {others.length === 0 && <p className="px-6 py-10 text-center text-sm text-zinc-400">There is nobody else on the team yet.</p>}
      </div>
    </div>
  )
}

/**
 * Group info (tap the group's name): the members, add people, rename, leave. Anyone in the group can add or rename.
 * Leaving asks once; nobody can remove another person.
 */
export function TalkGroupInfo({
  name, memberIds, members, meId, busy, onClose, onAdd, onRename, onLeave,
}: {
  name: string; memberIds: string[]; members: TalkMember[]; meId: string; busy: boolean
  onClose: () => void
  onAdd: (userIds: string[]) => void
  onRename: (name: string) => void
  onLeave: () => void
}) {
  const [mode, setMode] = useState<'info' | 'add' | 'rename' | 'leave'>('info')
  const [picked, setPicked] = useState<string[]>([])
  const [newName, setNewName] = useState(name)
  const inGroup = members.filter(m => memberIds.includes(m.id))
  const canAdd = membersNotInGroup(memberIds, members)

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" data-testid="talk-group-info">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="relative max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-white pb-[max(env(safe-area-inset-bottom),12px)] shadow-xl">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-zinc-300" />
        {mode === 'info' && (
          <>
            <div className="flex items-center gap-2 px-5 pb-1 pt-3">
              <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-zinc-900">{name}</h2>
              <span className="text-xs text-zinc-400">{memberIds.length} people</span>
            </div>
            <div>
              {inGroup.map(m => (
                <div key={m.id} className="flex items-center gap-3 px-5 py-2.5">
                  <Dot name={m.name} id={m.id} />
                  <span className="flex-1 truncate text-[16px] text-zinc-900">{m.name}{m.id === meId ? ' (you)' : ''}</span>
                </div>
              ))}
            </div>
            <div className="mt-1 border-t border-zinc-100">
              {canAdd.length > 0 && (
                <button type="button" onClick={() => { setPicked([]); setMode('add') }} data-testid="talk-group-add" className="flex w-full items-center gap-4 px-5 py-3.5 text-left text-[16px] text-zinc-900 active:bg-zinc-100">
                  <UserPlus className="h-5 w-5 text-zinc-500" />Add people
                </button>
              )}
              <button type="button" onClick={() => { setNewName(name); setMode('rename') }} data-testid="talk-group-rename" className="flex w-full items-center gap-4 px-5 py-3.5 text-left text-[16px] text-zinc-900 active:bg-zinc-100">
                <Pencil className="h-5 w-5 text-zinc-500" />Rename group
              </button>
              <button type="button" onClick={() => setMode('leave')} data-testid="talk-group-leave" className="flex w-full items-center gap-4 px-5 py-3.5 text-left text-[16px] text-red-600 active:bg-zinc-100">
                <LogOut className="h-5 w-5" />Leave group
              </button>
            </div>
          </>
        )}
        {mode === 'add' && (
          <>
            <div className="flex items-center gap-2 px-3 pb-1 pt-3">
              <button type="button" onClick={() => setMode('info')} aria-label="Back" className="flex h-10 w-10 items-center justify-center rounded-full text-zinc-700 active:bg-zinc-100"><ChevronLeft className="h-6 w-6" /></button>
              <h2 className="flex-1 text-lg font-semibold text-zinc-900">Add people</h2>
              <button type="button" disabled={picked.length === 0 || busy} onClick={() => onAdd(picked)} data-testid="talk-group-add-confirm" className="rounded-full bg-[#BE1E2D] px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40">{busy ? 'Adding…' : 'Add'}</button>
            </div>
            {canAdd.map(m => {
              const on = picked.includes(m.id)
              return (
                <button key={m.id} type="button" onClick={() => setPicked(p => on ? p.filter(x => x !== m.id) : [...p, m.id])} className="flex w-full items-center gap-3 px-5 py-2.5 text-left active:bg-zinc-50">
                  <Dot name={m.name} id={m.id} />
                  <span className="flex-1 truncate text-[16px] text-zinc-900">{m.name}</span>
                  <span className={cn('flex h-6 w-6 items-center justify-center rounded-full border', on ? 'border-[#BE1E2D] bg-[#BE1E2D] text-white' : 'border-zinc-300')}>{on && <Check className="h-4 w-4" />}</span>
                </button>
              )
            })}
          </>
        )}
        {mode === 'rename' && (
          <div className="px-5 pb-3 pt-4">
            <h2 className="mb-3 text-lg font-semibold text-zinc-900">Rename group</h2>
            <input autoFocus value={newName} maxLength={MAX_GROUP_NAME} onChange={e => setNewName(e.target.value)} className="h-11 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 text-[16px] outline-none" data-testid="talk-group-rename-input" />
            <div className="mt-3 flex gap-3">
              <button type="button" onClick={() => setMode('info')} className="flex-1 rounded-xl border border-zinc-200 py-3 text-[16px] text-zinc-800 active:bg-zinc-50">Cancel</button>
              <button type="button" disabled={!newName.trim() || busy} onClick={() => onRename(newName.trim())} data-testid="talk-group-rename-confirm" className="flex-1 rounded-xl bg-[#BE1E2D] py-3 text-[16px] font-semibold text-white disabled:opacity-40">{busy ? <Loader2 className="mx-auto h-5 w-5 animate-spin" /> : 'Save'}</button>
            </div>
          </div>
        )}
        {mode === 'leave' && (
          <div className="px-5 pb-3 pt-4">
            <p className="mb-3 text-[16px] text-zinc-900">Leave &ldquo;{name}&rdquo;? You will no longer see its messages unless someone adds you back.</p>
            <div className="flex gap-3">
              <button type="button" onClick={() => setMode('info')} className="flex-1 rounded-xl border border-zinc-200 py-3 text-[16px] text-zinc-800 active:bg-zinc-50">Cancel</button>
              <button type="button" disabled={busy} onClick={onLeave} data-testid="talk-group-leave-confirm" className="flex-1 rounded-xl bg-red-600 py-3 text-[16px] font-semibold text-white disabled:opacity-60">Leave</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
