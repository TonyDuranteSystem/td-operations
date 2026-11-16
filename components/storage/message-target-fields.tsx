'use client'

/**
 * Who a staff message goes to and under which topic: the choices (Send as / Addressed to / Topic) and the state behind them, shared by
 * the Message pop-up (components/storage/share-message-dialog.tsx — the document "eye" and the Message buttons/icons) and the Contact
 * page's Chat tab box, so the rules cannot drift: nothing is pre-selected when there is more than one open choice (the 2026-08-07 leak
 * rule), a closed company cannot be picked, a company message says who can see it, the member roster is fetched fresh for the chosen
 * company, and a typed topic reuses an existing one that differs only in case.
 */
import { useEffect, useMemo, useState } from 'react'
import { messageTopicChoices, normalizeTopic, resolveTypedTopic, topicChoices, type ShareContext, type ShareTarget } from '@/lib/portal/document-share-text'

export type MessageTargetContext = Extract<ShareContext, { askable: true }>

export interface MemberOption { memberId: string; name: string; resolvable: boolean }

/** What the chosen destination amounts to — exactly what the chat route needs besides the message text. */
export interface MessageSelection {
  target: ShareTarget
  topic: string
  addressedToMemberId: string | null
  addressedToCompany: boolean
}

export function useMessageTarget(ctx: MessageTargetContext, isMessage: boolean) {
  const openTargets = ctx.targets.filter((t) => !t.closed)
  const initialTarget = ctx.targets.find((t) => t.isDefault && !t.closed) ?? (isMessage && openTargets.length === 1 ? openTargets[0] : null)
  const [targetKey, setTargetKey] = useState<string | null>(initialTarget?.key ?? null)
  const target = ctx.targets.find((t) => t.key === targetKey) ?? null
  const [topic, setTopic] = useState(ctx.defaultTopic)
  const [newTopic, setNewTopic] = useState('')
  const [members, setMembers] = useState<MemberOption[]>([])
  const [memberId, setMemberId] = useState<string | null>(null) // null + wholeCompany = whole company
  const [wholeCompany, setWholeCompany] = useState(true)

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

  const topics = useMemo(() => (isMessage ? messageTopicChoices(target?.topics ?? []) : topicChoices(ctx.defaultTopic, target?.topics ?? [])), [isMessage, ctx.defaultTopic, target])
  const typed = normalizeTopic(newTopic)
  const finalTopic = typed ? resolveTypedTopic(typed, target?.topics ?? []) : topic

  const pickTarget = (t: ShareTarget) => { setTargetKey(t.key); setTopic(ctx.defaultTopic); setNewTopic('') }

  /** null until a destination is chosen. */
  const selection: MessageSelection | null = target
    ? {
        target, topic: finalTopic,
        addressedToMemberId: target.kind === 'company' && !wholeCompany ? memberId : null,
        addressedToCompany: target.kind === 'company' && members.length > 1 && wholeCompany,
      }
    : null

  return { targetKey, target, topic, setTopic, newTopic, setNewTopic, topics, typed, finalTopic, members, memberId, setMemberId, wholeCompany, setWholeCompany, pickTarget, selection }
}

export type MessageTargetState = ReturnType<typeof useMessageTarget>

/** The three groups of choices, in the order the pop-up has always shown them: Send as (+ notices), Addressed to, Topic. */
export function MessageTargetFields({ t, ctx, isMessage }: { t: MessageTargetState; ctx: MessageTargetContext; isMessage: boolean }) {
  const { target, targetKey, topic, setTopic, newTopic, setNewTopic, topics, typed, members, memberId, setMemberId, wholeCompany, setWholeCompany, pickTarget } = t
  return (
    <>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-500">Send as</label>
            <div className="flex flex-wrap gap-1.5">
              {ctx.targets.map((tg) => (
                <button key={tg.key} type="button" disabled={tg.closed} onClick={() => pickTarget(tg)}
                  className={`max-w-[260px] truncate rounded-full border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${targetKey === tg.key ? 'border-blue-600 bg-blue-600 text-white' : 'border-zinc-300 text-zinc-700 hover:bg-zinc-50'}`}>
                  {tg.label}{tg.closed ? " (client can't see this chat)" : ''}
                </button>
              ))}
            </div>
            {!target && <p className="mt-1.5 text-[11px] text-amber-700">{isMessage ? 'Pick who the message goes to.' : 'Pick who the message goes to, or choose "Show only".'}</p>}
            {target?.kind === 'company' && <p className="mt-1.5 text-[11px] text-amber-700">Visible to everyone in {target.label}.</p>}
          </div>
          {ctx.notice && <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">{ctx.notice}</p>}
          {ctx.info && <p className="rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-600">{ctx.info}</p>}

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
                <button key={t || 'general'} type="button" onClick={() => { setTopic(t); setNewTopic('') }}
                  className={`max-w-[200px] truncate rounded-full border px-3 py-1.5 text-sm ${!typed && topic === t ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-300 text-zinc-700 hover:bg-zinc-50'}`}>{t || 'General'}</button>
              ))}
            </div>
            <input value={newTopic} onChange={(e) => setNewTopic(e.target.value)} maxLength={100} placeholder="…or type a new topic"
              className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm" />
          </div>
    </>
  )
}
