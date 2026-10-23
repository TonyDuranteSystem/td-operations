'use client'

/**
 * The staff "eye" pop-up: asked when a hidden document is about to be shown to the client.
 *
 * Three ways out: "Send message" (show it + tell the client in chat), "No, just show it" (show it; the client gets the
 * portal notification only), "Cancel" / Escape / click outside (do nothing — the file stays hidden). Closing NEVER sends.
 *
 * Who it goes to comes from the document's own owner (pre-selected, never guessed); the person's other open companies
 * and the personal chat are the other choices. A closed company cannot be picked. Default topic is "Documents".
 * The send itself is done by the caller through POST /api/portal/chat, so every rule of a normal staff send applies.
 *
 * The window has a FIXED height with a scrolling body and a pinned button row: the member list loads after the window opens,
 * and a window that grew would move the buttons from under an aimed click (the same trap the Portal Chats pop-up had).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Send, X } from 'lucide-react'
import { trapTabKey } from '@/components/storage/focus-trap'
import { buildDocumentShareMessage, normalizeTopic, resolveTypedTopic, topicChoices, type ShareContext, type ShareTarget } from '@/lib/portal/document-share-text'

type Askable = Extract<ShareContext, { askable: true }>

export type ShareDialogResult =
  | { action: 'cancel' }
  | { action: 'just_show' }
  | { action: 'send'; target: ShareTarget; topic: string; message: string; addressedToMemberId: string | null; addressedToCompany: boolean }

interface MemberOption { memberId: string; name: string; resolvable: boolean }

export function ShareMessageDialog({ fileNames, ctx, note, onResult }: { fileNames: string[]; ctx: Askable; note?: string; onResult: (r: ShareDialogResult) => void }) {
  const initialTarget = ctx.targets.find((t) => t.isDefault && !t.closed) ?? null
  const [targetKey, setTargetKey] = useState<string | null>(initialTarget?.key ?? null)
  const target = ctx.targets.find((t) => t.key === targetKey) ?? null
  const [message, setMessage] = useState(() => buildDocumentShareMessage(ctx.locale, fileNames))
  const [topic, setTopic] = useState(ctx.defaultTopic)
  const [newTopic, setNewTopic] = useState('')
  const [members, setMembers] = useState<MemberOption[]>([])
  const [memberId, setMemberId] = useState<string | null>(null) // null + wholeCompany = whole company
  const [wholeCompany, setWholeCompany] = useState(true)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onResult({ action: 'cancel' }) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onResult])

  // the roster is fetched fresh for the chosen company (never reused across companies)
  const accountId = target?.kind === 'company' ? target.accountId : null
  useEffect(() => {
    setMembers([]); setMemberId(null); setWholeCompany(true)
    if (!accountId) return
    let cancelled = false
    fetch(`/api/portal/chat/members?account_id=${encodeURIComponent(accountId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d && Array.isArray(d.members)) setMembers(d.members as MemberOption[]) })
      .catch(() => { /* the label is optional — no roster just means no "Addressed to" row */ })
    return () => { cancelled = true }
  }, [accountId])

  const topics = useMemo(() => topicChoices(ctx.defaultTopic, target?.topics ?? []), [ctx.defaultTopic, target])
  const typed = normalizeTopic(newTopic)
  const finalTopic = typed ? resolveTypedTopic(typed, target?.topics ?? []) : topic
  const canSend = !!target && !target.closed && !!message.trim() && !!finalTopic && !busy

  const send = () => {
    if (!canSend || !target) return
    setBusy(true) // one click only — the caller closes the pop-up
    onResult({
      action: 'send', target, topic: finalTopic, message: message.trim(),
      addressedToMemberId: target.kind === 'company' && !wholeCompany ? memberId : null,
      addressedToCompany: target.kind === 'company' && members.length > 1 && wholeCompany,
    })
  }

  return (
    <div className="fixed inset-0 z-[62] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Tell the client about this document?"
      onClick={() => onResult({ action: 'cancel' })}>
      <div ref={rootRef} className="flex h-[min(92vh,680px)] w-full max-w-lg flex-col rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()} onKeyDown={trapTabKey}>
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Send className="h-4 w-4 text-blue-500" />
          <h3 className="text-sm font-semibold text-zinc-800">Tell the client about {fileNames.length > 1 ? 'these documents' : 'this document'}?</h3>
          <button type="button" aria-label="Cancel" onClick={() => onResult({ action: 'cancel' })} className="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-100"><X className="h-4 w-4" /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
          <p className="break-words text-zinc-600"><strong>{fileNames[0]}</strong>{fileNames.length > 1 ? ` and ${fileNames.length - 1} more` : ''} will be shown to the client either way. The client always gets the portal notification.</p>
          {note && <p className="text-xs text-zinc-500">{note}</p>}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-500">Send as</label>
            <div className="flex flex-wrap gap-1.5">
              {ctx.targets.map((t) => (
                <button key={t.key} type="button" disabled={t.closed} onClick={() => { setTargetKey(t.key); setTopic(ctx.defaultTopic); setNewTopic('') }}
                  className={`max-w-[260px] truncate rounded-full border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${targetKey === t.key ? 'border-blue-600 bg-blue-600 text-white' : 'border-zinc-300 text-zinc-700 hover:bg-zinc-50'}`}>
                  {t.label}{t.closed ? " (client can't see this chat)" : ''}
                </button>
              ))}
            </div>
            {!target && <p className="mt-1.5 text-[11px] text-amber-700">Pick who the message goes to, or choose &quot;No, just show it&quot;.</p>}
            {target?.kind === 'company' && <p className="mt-1.5 text-[11px] text-amber-700">Visible to everyone in {target.label}.</p>}
          </div>

          {target?.kind === 'company' && members.length > 1 && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-500">Addressed to</label>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" onClick={() => { setWholeCompany(true); setMemberId(null) }}
                  className={`rounded-full border px-3 py-1.5 text-sm ${wholeCompany ? 'border-teal-600 bg-teal-600 text-white' : 'border-zinc-300 text-zinc-700 hover:bg-zinc-50'}`}>Whole company</button>
                {members.map((m) => m.resolvable ? (
                  <button key={m.memberId} type="button" onClick={() => { setWholeCompany(false); setMemberId(m.memberId) }}
                    className={`rounded-full border px-3 py-1.5 text-sm ${!wholeCompany && memberId === m.memberId ? 'border-teal-600 bg-teal-600 text-white' : 'border-zinc-300 text-zinc-700 hover:bg-zinc-50'}`}>{m.name}</button>
                ) : (
                  <span key={m.memberId} title="No linked contact on file for this member yet" className="cursor-not-allowed rounded-full border border-zinc-200 px-3 py-1.5 text-sm text-zinc-300">{m.name}</span>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-zinc-400">Label only — the whole company still sees this message.</p>
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-500">Topic</label>
            <div className="flex flex-wrap gap-1.5">
              {topics.map((t) => (
                <button key={t} type="button" onClick={() => { setTopic(t); setNewTopic('') }}
                  className={`max-w-[200px] truncate rounded-full border px-3 py-1.5 text-sm ${!typed && topic === t ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-300 text-zinc-700 hover:bg-zinc-50'}`}>{t}</button>
              ))}
            </div>
            <input value={newTopic} onChange={(e) => setNewTopic(e.target.value)} maxLength={100} placeholder="…or type a new topic"
              className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm" />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-500">Message ({ctx.locale === 'it' ? 'Italian' : 'English'} — you can edit it)</label>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} maxLength={5000} className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm" />
            <p className="mt-1 text-[11px] text-zinc-400">The client may get an email about the message too, but not every time (at most one email per chat every 2 hours).</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
          <button type="button" onClick={() => onResult({ action: 'cancel' })} className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">Cancel</button>
          <button type="button" disabled={busy} onClick={() => { setBusy(true); onResult({ action: 'just_show' }) }} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50">No, just show it</button>
          <button type="button" disabled={!canSend} onClick={send} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40">{busy ? 'Sending…' : 'Send message'}</button>
        </div>
      </div>
    </div>
  )
}
