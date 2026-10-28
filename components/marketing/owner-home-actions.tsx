'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The buttons on Antonio's Home (TD Marketing, dev job 9aec66fa, Addendum H: "see and act as well"): answer a message, give a lead to a person or a team, remind the person who has a lead.
 * English, like the rest of his CRM section. Every server answer, including a refusal, is shown as written (R099).
 */
async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; throw new Error(d.error || 'Could not send. Please try again.') }
}
const fail = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Could not send. Please try again.')
const field = 'rounded-lg border bg-white px-2 py-1.5 text-sm'

/** A reply box under a message: Enter or the button sends it to that conversation (a lead's chat or a direct message), then the list refreshes. */
export function ReplyBox({ url }: { url: string }) {
  const router = useRouter()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  async function send() {
    if (!text.trim() || busy) return
    setBusy(true); setError(null)
    try { await post(url, { message: text }); setText(''); setSent(true); router.refresh() } catch (e) { setError(fail(e)) } finally { setBusy(false) }
  }
  return (
    <div className="pb-2" data-testid="reply-box">
      <div className="flex gap-2">
        <input className={`${field} min-w-0 flex-1`} placeholder="Reply here and press Enter" value={text} aria-label="Reply" data-testid="reply-input"
          onChange={e => { setText(e.target.value); setSent(false) }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void send() } }} />
        <button type="button" className="rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" disabled={busy || !text.trim()} onClick={send} data-testid="reply-send">{busy ? 'Sending…' : 'Send'}</button>
      </div>
      {sent && <p role="status" className="mt-1 text-xs text-emerald-700" data-testid="reply-sent">Sent.</p>}
      {error && <p role="alert" className="mt-1 rounded-lg bg-rose-50 px-2 py-1 text-xs text-rose-800" data-testid="reply-error">{error}</p>}
    </div>
  )
}

/** "Assign to": gives a lead nobody picked to a person of the team who works the leads. */
export function GiveBox({ leadId, people }: { leadId: string; people: Array<{ id: string; name: string }> }) {
  const router = useRouter()
  const [personId, setPersonId] = useState(people[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (people.length === 0) return <span className="text-xs text-slate-500">No seller in the team yet.</span>
  async function give() {
    setBusy(true); setError(null)
    try { await post(`/api/marketing-admin/leads/${leadId}/give`, { personId }); router.refresh() } catch (e) { setError(fail(e)) } finally { setBusy(false) }
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-testid="give-box">
      <select aria-label="Give to" className={field} value={personId} onChange={e => setPersonId(e.target.value)} data-testid="give-select">{people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <button type="button" className="rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" disabled={busy || !personId} onClick={give} data-testid="give-send">{busy ? 'Saving…' : 'Assign'}</button>
      {error && <span role="alert" className="w-full rounded-lg bg-rose-50 px-2 py-1 text-xs text-rose-800" data-testid="give-error">{error}</span>}
    </span>
  )
}

/** "Give to a team": a lead that arrived with no team. */
export function TeamBox({ leadId, teams, defaultTeamId }: { leadId: string; teams: Array<{ id: string; name: string }>; defaultTeamId?: string }) {
  const router = useRouter()
  // the team on screen is the likely answer
  const [teamId, setTeamId] = useState(teams.some(t => t.id === defaultTeamId) ? (defaultTeamId as string) : (teams[0]?.id ?? ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function give() {
    setBusy(true); setError(null)
    try { await post(`/api/marketing-admin/leads/${leadId}/assign`, { teamId }); router.refresh() } catch (e) { setError(fail(e)) } finally { setBusy(false) }
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-testid="team-box">
      <select aria-label="Team" className={field} value={teamId} onChange={e => setTeamId(e.target.value)}>{teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
      <button type="button" className="rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" disabled={busy || !teamId} onClick={give} data-testid="team-send">{busy ? 'Saving…' : 'Give to team'}</button>
      {error && <span role="alert" className="w-full rounded-lg bg-rose-50 px-2 py-1 text-xs text-rose-800">{error}</span>}
    </span>
  )
}

/** "Send reminder": opens a short text, already written (Italian, as the team works), that Antonio can change before it goes as a private direct message to the person who has the lead. */
export function RemindBox({ leadId, name }: { leadId: string; name: string }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(`Promemoria: il link di pagamento di ${name} è stato inviato più di 48 ore fa e non risulta ancora pagato.`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  async function send() {
    setBusy(true); setError(null)
    try { await post(`/api/marketing-admin/leads/${leadId}/remind`, { message: text }); setSent(true); setOpen(false) } catch (e) { setError(fail(e)) } finally { setBusy(false) }
  }
  if (sent) return <span role="status" className="text-xs text-emerald-700" data-testid="remind-sent">Reminder sent.</span>
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-testid="remind-box">
      {!open ? <button type="button" className="rounded-lg border px-2 py-1 text-xs hover:bg-slate-50" onClick={() => setOpen(true)} data-testid="remind-open">Send reminder</button> : (
        <span className="flex w-full flex-col gap-2">
          <textarea className={`${field} min-h-[3.5rem] w-full`} value={text} onChange={e => setText(e.target.value)} aria-label="Reminder text" data-testid="remind-text" />
          <span className="flex gap-2"><button type="button" className="rounded-lg bg-teal-700 px-3 py-1 text-xs font-medium text-white disabled:opacity-50" disabled={busy || !text.trim()} onClick={send} data-testid="remind-send">{busy ? 'Sending…' : 'Send privately'}</button><button type="button" className="rounded-lg border px-3 py-1 text-xs" onClick={() => setOpen(false)}>Cancel</button></span>
        </span>
      )}
      {error && <span role="alert" className="w-full rounded-lg bg-rose-50 px-2 py-1 text-xs text-rose-800" data-testid="remind-error">{error}</span>}
    </span>
  )
}
