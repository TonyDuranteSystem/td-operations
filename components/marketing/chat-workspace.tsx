'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLang, useT } from '@/components/marketing/lang-provider'
import { useLeadWindows } from '@/components/marketing/lead-windows-host'
import { TeamChat } from '@/components/marketing/lead-chat'
import { localeFor } from '@/lib/marketing/i18n'
import { formatWhen } from '@/lib/marketing/lead-view'
import type { Conversation } from '@/lib/marketing/lead-chat-server'
import type { ThreadRow } from '@/lib/marketing/team-chat'

interface Person { id: string; name: string }
interface Snapshot { threads: ThreadRow[]; people: Person[]; me: string }
type Dialog = 'dm' | 'group' | 'info' | null

const POLL_MS = 8_000
const btn = 'rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50'

/**
 * TD Marketing — the Chat page (dev job 9aec66fa, round 2 step 3): direct messages, groups and the chats about leads in one list, each with its red number (and a yellow @ when somebody
 * named you). A direct message or a group opens on the right with the lead chat's own screen (text, voice, photos, files, reactions, replies, ticks); a lead chat opens its lead window on the Chat tab,
 * as before. The list refreshes by itself while the page is on screen.
 */
export function ChatWorkspace({ initial, leadConversations, showLeads, startThread }: { initial: Snapshot; leadConversations: Conversation[]; showLeads: boolean; startThread: string | null }) {
  const t = useT()
  const lang = useLang()
  const { open } = useLeadWindows()
  const [snap, setSnap] = useState<Snapshot>(initial)
  const [sel, setSel] = useState<string | null>(startThread && initial.threads.some(x => x.id === startThread) ? startThread : null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState(false)
  const fails = useRef(0)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/marketing/team-chat/threads')
      if (!r.ok) throw new Error('list')
      setSnap(await r.json() as Snapshot)
      fails.current = 0; setOffline(false)
    } catch { if (++fails.current >= 3) setOffline(true) }
  }, [])
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') void refresh() }
    const timer = setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [refresh])

  const select = (id: string) => {
    setSel(id)
    // what is open is read: the number goes at once (the chat itself marks the messages read while it is on screen)
    setSnap(s => ({ ...s, threads: s.threads.map(x => (x.id === id ? { ...x, unread: 0, mentioned: false } : x)) }))
    try { window.history.replaceState(null, '', `${window.location.pathname}?thread=${id}`) } catch { /* the address is only cosmetic */ }
  }
  const post = async (body: object): Promise<string | null> => {
    setBusy(true); setError('')
    try {
      const r = await fetch('/api/marketing/team-chat/threads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error ? t(d.error) : t('Could not do that. Please try again.'))
      return d.thread_id as string
    } catch (e) { setError(e instanceof Error && e.message ? e.message : t('Could not do that. Please try again.')); return null } finally { setBusy(false) }
  }

  const dms = snap.threads.filter(x => x.kind === 'dm')
  const groups = snap.threads.filter(x => x.kind === 'group')
  const current = snap.threads.find(x => x.id === sel) ?? null
  const nameOf = (id: string) => (id === snap.me ? t('You') : snap.people.find(p => p.id === id)?.name ?? t('Someone'))

  const row = (x: ThreadRow) => (
    <li key={x.id}>
      <button type="button" onClick={() => select(x.id)} data-testid="thread-row" data-thread={x.id} aria-current={x.id === sel ? 'true' : undefined}
        className={`flex w-full items-start justify-between gap-2 border-l-4 px-3 py-2 text-left hover:bg-slate-50 ${x.id === sel ? 'border-slate-900 bg-slate-50' : 'border-transparent'}`}>
        <span className="min-w-0"><b className="block truncate text-sm font-medium">{x.title}</b><span className="block truncate text-xs text-slate-500">{x.lastBy ? `${x.lastBy}: ` : ''}{x.last ? t(x.last) : t('No messages yet.')}</span></span>
        <span className="flex shrink-0 items-center gap-1">
          {x.mentioned && <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white" data-testid="thread-mention" aria-label={t('You were mentioned')}>@</span>}
          {x.unread > 0 && <span className="rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white" data-testid="thread-unread" aria-label={t('{n} unread messages', { n: x.unread })}>{x.unread}</span>}
        </span>
      </button>
    </li>
  )

  return (
    <div className="space-y-3">
      {offline && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{t('Connection problem. New messages may be late; trying again.')}</p>}
      <div className="grid h-[calc(100vh-13rem)] min-h-[30rem] grid-cols-[19rem_minmax(0,1fr)] overflow-hidden rounded-xl border bg-white" data-testid="chat-workspace">
        <div className="overflow-y-auto border-r">
          <div className="flex items-center justify-between px-3 pb-1 pt-3"><h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{t('Direct messages')}</h2><button type="button" className="text-xs text-sky-700 hover:underline" data-testid="new-dm" onClick={() => { setError(''); setDialog('dm') }}>{t('+ New')}</button></div>
          <ul>{dms.length === 0 ? <li className="px-3 py-1 text-xs text-slate-400">{t('None yet.')}</li> : dms.map(row)}</ul>
          <div className="flex items-center justify-between px-3 pb-1 pt-4"><h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{t('Groups')}</h2><button type="button" className="text-xs text-sky-700 hover:underline" data-testid="new-group" onClick={() => { setError(''); setDialog('group') }}>{t('+ New group')}</button></div>
          <ul>{groups.length === 0 ? <li className="px-3 py-1 text-xs text-slate-400">{t('None yet.')}</li> : groups.map(row)}</ul>
          {showLeads && (
            <>
              <h2 className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{t('Chats about leads')}</h2>
              <ul data-testid="lead-conversations">
                {leadConversations.length === 0 ? <li className="px-3 py-1 text-xs text-slate-400">{t('No conversations yet. Open a lead and write in its Chat tab.')}</li> : leadConversations.map(c => (
                  <li key={c.leadId}>
                    <button type="button" onClick={() => open({ id: c.leadId, name: c.name }, 'chat')} data-testid="conversation" data-lead={c.leadId} className="flex w-full items-start justify-between gap-2 border-l-4 border-transparent px-3 py-2 text-left hover:bg-slate-50">
                      <span className="min-w-0"><b className="block truncate text-sm font-medium">{c.name}</b><span className="block truncate text-xs text-slate-500">{c.lastBy ? `${c.lastBy}: ` : ''}{t(c.last)}</span></span>
                      <span className="flex shrink-0 flex-col items-end gap-1"><span className="text-[11px] text-slate-400">{formatWhen(c.lastAt, 'Europe/Rome', localeFor(lang))}</span>{c.unread > 0 && <span className="rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white" data-testid="conversation-unread">{c.unread}</span>}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="flex min-h-0 min-w-0 flex-col" data-testid="chat-pane">
          {current ? (
            <>
              <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5">
                <div className="min-w-0"><b className="block truncate" data-testid="thread-title">{current.title}</b>{current.kind === 'group' && <span className="block truncate text-xs text-slate-500">{current.memberIds.map(nameOf).join(', ')}</span>}</div>
                {current.kind === 'group' && <button type="button" className={btn} data-testid="group-info" onClick={() => { setError(''); setDialog('info') }}>{t('Group info')}</button>}
              </div>
              <div className="min-h-0 flex-1"><TeamChat key={current.id} threadId={current.id} /></div>
            </>
          ) : <div className="flex flex-1 items-center justify-center text-sm text-slate-500">{t('Pick a chat on the left, or start a new one.')}</div>}
        </div>
      </div>

      {dialog === 'dm' && (
        <Modal title={t('New message')} onClose={() => setDialog(null)} testId="dm-dialog">
          <p className="text-xs text-slate-500">{t('Pick a person. If you already talk, that chat opens.')}</p>
          <ul className="divide-y">{snap.people.length === 0 ? <li className="py-2 text-sm text-slate-500">{t('There is nobody else in the chat yet.')}</li> : snap.people.map(p => (
            <li key={p.id} className="py-1.5"><button type="button" className={btn} disabled={busy} data-testid="dm-person" onClick={async () => { const id = await post({ kind: 'dm', user_id: p.id }); if (id) { setDialog(null); await refresh(); select(id) } }}>{t('Message {name}', { name: p.name })}</button></li>
          ))}</ul>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        </Modal>
      )}
      {dialog === 'group' && <GroupDialog people={snap.people} busy={busy} error={error} onClose={() => setDialog(null)} onCreate={async (title, ids) => { const id = await post({ kind: 'group', title, member_ids: ids }); if (id) { setDialog(null); await refresh(); select(id) } }} />}
      {dialog === 'info' && current && <InfoDialog thread={current} people={snap.people} nameOf={nameOf} onClose={() => setDialog(null)} onChanged={async leave => { setDialog(null); if (leave) { setSel(null); try { window.history.replaceState(null, '', window.location.pathname) } catch { /* cosmetic */ } } await refresh() }} />}
    </div>
  )
}

function Modal({ title, onClose, children, testId }: { title: string; onClose: () => void; children: React.ReactNode; testId: string }) {
  const t = useT()
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
      <div className="max-h-[92vh] w-full max-w-md space-y-3 overflow-auto rounded-xl bg-white p-5 shadow-2xl">
        <h2 className="text-base font-semibold">{title}</h2>
        {children}
        <div className="flex justify-end"><button type="button" className={btn} onClick={onClose} data-testid="dialog-close">{t('Close')}</button></div>
      </div>
    </div>
  )
}

function GroupDialog({ people, busy, error, onClose, onCreate }: { people: Person[]; busy: boolean; error: string; onClose: () => void; onCreate: (title: string, ids: string[]) => void }) {
  const t = useT()
  const [title, setTitle] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const ready = title.trim() !== '' && picked.length >= 1 && !busy
  return (
    <Modal title={t('New group')} onClose={onClose} testId="group-dialog">
      <p className="text-xs text-slate-500">{t('Everyone you add can read and write in it.')}</p>
      <label className="block text-xs text-slate-600">{t('Group name')}<input value={title} onChange={e => setTitle(e.target.value)} maxLength={80} data-testid="group-name" className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm" /></label>
      <fieldset><legend className="text-xs text-slate-600">{t('Members')}</legend>
        {people.map(p => <label key={p.id} className="flex items-center gap-2 border-t py-1.5 text-sm"><input type="checkbox" checked={picked.includes(p.id)} onChange={e => setPicked(e.target.checked ? [...picked, p.id] : picked.filter(x => x !== p.id))} data-testid="group-member" data-user={p.id} />{p.name}</label>)}
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-700" data-testid="group-error">{error}</p>}
      <div className="flex justify-end"><button type="button" className={`${btn} bg-slate-900 text-white hover:bg-slate-800`} disabled={!ready} data-testid="group-create" onClick={() => onCreate(title, picked)}>{busy ? t('Saving…') : t('Create group')}</button></div>
    </Modal>
  )
}

function InfoDialog({ thread, people, nameOf, onClose, onChanged }: { thread: ThreadRow; people: Person[]; nameOf: (id: string) => string; onClose: () => void; onChanged: (leave: boolean) => void }) {
  const t = useT()
  const [title, setTitle] = useState(thread.title)
  const [add, setAdd] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sure, setSure] = useState(false)
  const outside = people.filter(p => !thread.memberIds.includes(p.id))
  const call = async (body: object, leave = false) => {
    setBusy(true); setError('')
    try {
      const r = await fetch(`/api/marketing/team-chat/${thread.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error ? t(d.error) : t('Could not do that. Please try again.')) }
      onChanged(leave)
    } catch (e) { setError(e instanceof Error && e.message ? e.message : t('Could not do that. Please try again.')); setBusy(false) }
  }
  return (
    <Modal title={t('Group info')} onClose={onClose} testId="info-dialog">
      <label className="block text-xs text-slate-600">{t('Group name')}
        <span className="mt-1 flex gap-2"><input value={title} onChange={e => setTitle(e.target.value)} maxLength={80} data-testid="info-name" className="w-full rounded-lg border px-2 py-1.5 text-sm" /><button type="button" className={btn} disabled={busy || title.trim() === '' || title.trim() === thread.title} data-testid="info-rename" onClick={() => call({ action: 'rename', title })}>{t('Rename')}</button></span>
      </label>
      <p className="text-xs text-slate-600">{t('In this group:')} {thread.memberIds.map(nameOf).join(', ')}</p>
      {outside.length > 0 && (
        <fieldset><legend className="text-xs text-slate-600">{t('Add people')}</legend>
          {outside.map(p => <label key={p.id} className="flex items-center gap-2 border-t py-1.5 text-sm"><input type="checkbox" checked={add.includes(p.id)} onChange={e => setAdd(e.target.checked ? [...add, p.id] : add.filter(x => x !== p.id))} data-testid="info-add-member" />{p.name}</label>)}
          <button type="button" className={`${btn} mt-1`} disabled={busy || add.length === 0} data-testid="info-add" onClick={() => call({ action: 'add', memberIds: add })}>{t('Add to the group')}</button>
        </fieldset>
      )}
      {error && <p role="alert" className="text-sm text-red-700" data-testid="info-error">{error}</p>}
      <div className="border-t pt-3">
        {sure
          ? <button type="button" className={`${btn} border-red-300 text-red-700`} disabled={busy} data-testid="info-leave-sure" onClick={() => call({ action: 'leave' }, true)}>{t('Yes, leave the group')}</button>
          : <button type="button" className={btn} data-testid="info-leave" onClick={() => setSure(true)}>{t('Leave the group')}</button>}
      </div>
    </Modal>
  )
}
