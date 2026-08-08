'use client'

/**
 * WorkerChatPanel — the Slack worker embedded in the Inbox (Antonio,
 * 2026-07-08: "the same worker I have in Slack with the same power").
 *
 * Slide-over chat next to the open email thread. Calls
 * /api/inbox/worker-chat, which runs the shared read-only worker
 * (DB/CRM/KB/Gmail reads + central memory recall + propose_action) with the
 * Slack persona. Conversation memory is persistent PER EMAIL THREAD
 * (threadId inbox-<mailbox>-<gmailThreadId>) — closing and reopening the
 * panel on the same email continues the same conversation.
 */

import { useEffect, useRef, useState } from 'react'
import { Bot, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { WorkerMarkdown } from '@/components/chat/worker-markdown'
import {
  WorkerArtifactLinks,
  parseWorkerArtifacts,
  type WorkerArtifactLink,
} from '@/components/chat/worker-artifacts'
import { ConfirmAttachments } from '@/components/inbox/confirm-attachments'
import { SignatureControls, SignaturePreview } from '@/components/inbox/signature-controls'
import { DEFAULT_SIGNATURE_VARIANT, type SignatureVariant } from '@/lib/email/signature'
import { WorkerComposer } from '@/components/chat/worker-composer'
import { WorkerDropZone } from '@/components/chat/worker-dropzone'
import { WorkerSettingsGear } from '@/components/chat/worker-settings-gear'
import { useWorkerAttachments, type UploadedAttachment } from '@/components/chat/use-worker-attachments'
import type { InboxConversation } from '@/lib/types'

interface ChatMsg {
  role: 'user' | 'worker'
  text: string
  /**
   * Files the worker PRODUCED on this turn (Antonio, 2026-08-05: "must be able to
   * produce files everywhere"). Server-attested — captured from the file-building
   * tool's own output, never parsed from the reply text, so the download is there
   * whatever the worker happens to write about it.
   *
   * NOT restored by the history fetch: only the live turn carries them, because the
   * links are time-limited and a resurrected expired link is a button that fails.
   */
  artifacts?: WorkerArtifactLink[]
  /**
   * Server-attested off-thread address the worker tried to email and was refused.
   * When set, this worker bubble shows a "Confirm & send" button. The address
   * comes from the server (the real refused attempt), never parsed from the reply.
   */
}

interface PreparedSend {
  id: string
  /**
   * "email" | "portal". The two cards are NOT interchangeable: a portal draft has no
   * recipient address and no subject, and its recipient is chosen here rather than
   * frozen. Rendering one as the other produces "Email —" with a mailbox picker and a
   * Confirm that cannot work.
   */
  kind: string
  to: string | null
  subject: string | null
  /** The exact text that will be sent — rendered so Confirm approves a MESSAGE,
   *  not just an address. */
  body: string
  attachments: Array<{ name: string; size?: number; content_type?: string; origin?: string; warning?: string }>
  /** Portal only — the client the worker suggested. A chip to click, never pre-selected. */
  /** Set when the frozen text is confidently NOT the language the card claims. */
  languageMismatch?: 'en' | 'it' | null
  proposedAccountId?: string | null
  proposedContactId?: string | null
  proposedName?: string | null
}

/** One row of the all-roles client search, as the picker renders it. */
interface ClientTarget {
  type: 'account' | 'contact' | 'lead' | 'partner'
  id: string
  name: string
  detail?: string
}

interface WorkerChatPanelProps {
  conversation: InboxConversation
  mailbox?: string
  onClose: () => void
}

export function WorkerChatPanel({ conversation, mailbox, onClose }: WorkerChatPanelProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [preparedSend, setPreparedSend] = useState<PreparedSend | null>(null)
  const [confirming, setConfirming] = useState(false)
  // WHICH OF OUR ADDRESSES IT GOES OUT FROM — the staff member chooses on the card
  // (Antonio, 2026-07-29). The server re-checks that they may send as it.
  //
  // DEFAULTS TO THE MAILBOX THIS THREAD LIVES IN. Defaulting to support@ meant a
  // reply on an antonio@ conversation silently went out from support@ with the
  // team sign-off unless the dropdown was touched every time — a changed sending
  // identity mid-conversation, which the counterparty sees and staff would not.
  const [sendAs, setSendAs] = useState<'support' | 'antonio'>(mailbox === 'antonio' ? 'antonio' : 'support')
  // WHICH SIGNATURE goes on the email — the staff member picks on the card
  // (Luca's Team Chat request; Antonio approved 2026-08-07). Same chooser as
  // manual compose/reply; applied server-side at confirm time. Defaults to the
  // full signature — exactly what every worker send used before the picker.
  const [signatureVariant, setSignatureVariant] = useState<SignatureVariant>(DEFAULT_SIGNATURE_VARIANT)

  /* ── PORTAL CARD STATE ────────────────────────────────────────────────────
   * Antonio, 2026-07-31: the card asks WHO it goes to and in WHICH language, the
   * worker writes the message, and Reformulate sends it back for a rewrite.
   */
  /** WHO. Starts EMPTY — always. The worker's suggestion is rendered as a chip the
   *  staff member must click. A pre-selected picker turns Confirm into a one-click
   *  send to a client nobody chose, on a screen full of mail written by strangers. */
  const [portalTarget, setPortalTarget] = useState<ClientTarget | null>(null)
  const [clientQuery, setClientQuery] = useState('')
  const [clientResults, setClientResults] = useState<ClientTarget[]>([])
  const [searching, setSearching] = useState(false)
  /** WHICH LANGUAGE the worker must WRITE in. Switching it REWRITES the message on the
   *  card immediately (Antonio, 2026-08-01) — see the dropdown below. Sent with every
   *  turn so the worker always knows which language it is writing for. */
  /**
   * REMEMBERED PER EMAIL THREAD. Reloading the panel used to snap this back to English
   * while the conversation carried on in Italian — so the card said English, the
   * message was Italian, and even a perfectly obedient worker had been handed a
   * contradiction. The conversation survives a reload; the language setting has to as
   * well. Scoped to this thread so a different email starts fresh.
   */
  const localeKey = `td-portal-locale:${conversation.id}`
  const [portalLocale, setPortalLocale] = useState<'en' | 'it'>(() => {
    if (typeof window === 'undefined') return 'en'
    return window.localStorage.getItem(localeKey) === 'it' ? 'it' : 'en'
  })
  /** Language to restore if a switch-triggered rewrite fails — see the dropdown. */
  const [, setLocaleRollback] = useState<'en' | 'it' | null>(null)
  /**
   * CAN THE PICKED TARGET ACTUALLY RECEIVE THIS — and have they ever signed in?
   * Antonio, 2026-08-02: "before the send is allowed, check whether the chosen target
   * already has access to the system and if it accessed."
   */
  const [reach, setReach] = useState<{
    checking: boolean
    reachable: boolean | null
    reason?: string
    resolvedName?: string | null
    recipients?: Array<{ name: string | null; email: string | null; hasLogin: boolean; lastSignInAt: string | null }>
    neverSignedIn?: boolean
    target?: { accountId?: string; contactId?: string }
  }>({ checking: false, reachable: null })
  const [reformulating, setReformulating] = useState(false)
  const [reformulateText, setReformulateText] = useState('')

  const scrollRef = useRef<HTMLDivElement>(null)
  const sentContextRef = useRef(false)
  const attachments = useWorkerAttachments()

  const resolvePreparedSend = async (action: 'confirm' | 'cancel') => {
    if (!preparedSend || confirming) return
    setConfirming(true)
    try {
      const isPortal = preparedSend.kind === 'portal'
      // The chosen client travels with the click, not with the freeze — this is the
      // one card where the recipient is decided at the last moment, so the server
      // re-validates it before anything is written.
      const res = await fetch('/api/inbox/worker-chat/confirm-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prepared_id: preparedSend.id,
          action,
          mailbox: sendAs,
          // The signature pick rides the SAME click as the mailbox pick — the
          // server applies it to the frozen payload at dispatch. Portal rows
          // ignore it (portal messages carry no email signature).
          ...(isPortal ? {} : { signature_variant: signatureVariant }),
          // The RESOLVED target, not the raw pick: choosing a lead sends to that
          // person's contact, which is where their portal login actually lives.
          ...(isPortal && portalTarget
            ? reach.target?.accountId
              ? { account_id: reach.target.accountId }
              : reach.target?.contactId
                ? { contact_id: reach.target.contactId }
                : portalTarget.type === 'account'
                  ? { account_id: portalTarget.id }
                  : { contact_id: portalTarget.id }
            : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not complete — please try again.')
      setMessages(prev => [
        ...prev,
        {
          role: 'worker',
          text: action === 'cancel'
            ? 'Cancelled — nothing was sent.'
            : isPortal
              // Says whether the client was actually EMAILED about it. The portal's
              // "you have a new message" email is throttled to one per conversation
              // every two hours, so a bare "Sent" would be untrue half the time.
              // Says ONLY what is known: the message is in the portal. Whether the
              // client's "you have a new message" email went is decided elsewhere,
              // fire-and-forget, and its result never reaches here — so any sentence
              // about it would be a guess dressed as fact. The old wording asserted
              // "no email went out" on every single send and was wrong every time.
              // No claim about the client email: whether it went is decided
              // fire-and-forget elsewhere and never comes back here. The old wording
              // asserted "no email went out" on every send and was wrong every time.
              ? `✅ Posted to ${data.recipientName ?? 'the client'}'s portal chat.`
              : (preparedSend.attachments.length
                  ? `✅ Sent to ${preparedSend.to} with ${preparedSend.attachments.map(a => a.name).join(', ')} attached.`
                  : `✅ Sent to ${preparedSend.to}.`),
        },
      ])
      setPreparedSend(null)
      setPortalTarget(null)
      setClientQuery('')
      setClientResults([])
    } catch (err) {
      setMessages(prev => [
        ...prev,
        { role: 'worker', text: `⚠️ ${err instanceof Error && err.message ? err.message : 'Could not complete.'}` },
      ])
    } finally {
      setConfirming(false)
    }
  }

  // CLIENT SEARCH for the portal card. Reuses the SAME all-roles endpoint the Inbox's
  // "Link to client" dialog uses (companies, contacts, leads, partners) — Antonio:
  // "That field must check for everything from contact, company, lead, everything."
  useEffect(() => {
    const q = clientQuery.trim()
    if (q.length < 2) { setClientResults([]); return }
    let alive = true
    setSearching(true)
    const t = setTimeout(() => {
      fetch(`/api/inbox/link-targets?q=${encodeURIComponent(q)}`)
        .then(r => r.json())
        .then((d: { targets?: ClientTarget[] }) => { if (alive) setClientResults(d.targets ?? []) })
        .catch(() => { if (alive) setClientResults([]) })
        .finally(() => { if (alive) setSearching(false) })
    }, 200)
    return () => { alive = false; clearTimeout(t) }
  }, [clientQuery])

  /**
   * The staff member picked a DIFFERENT client than the one the message was written
   * for. Blocks Confirm: the wording may name the wrong person, and the only honest
   * repair is a rewrite (never a silent substitution — the card's promise is that what
   * you read is what is sent).
   *
   * Only meaningful when the worker actually proposed someone. No proposal = nothing to
   * compare, so this stays quiet; the prompt rule against naming a client in the message
   * is what covers that case.
   */
  /**
   * The staff member picked a DIFFERENT SCOPE of the same client, not a different
   * client: the worker proposed the company and they chose one of its members, or the
   * worker proposed a person and they chose that person's company.
   *
   * Resolved against the account's real member list rather than guessed, because the
   * ids never match each other and a name comparison would break on "Mario Rossi" vs
   * "Rossi Consulting LLC".
   */
  const [scopeSiblingIds, setScopeSiblingIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    const accId = preparedSend?.proposedAccountId
    const conId = preparedSend?.proposedContactId
    if (preparedSend?.kind !== 'portal' || (!accId && !conId)) { setScopeSiblingIds(new Set()); return }
    // CLEARED BEFORE THE FETCH, not after. Otherwise a NEW card inherits the PREVIOUS
    // card's member list for the length of the round trip, and picking one of those
    // people in that window suppresses the mismatch warning — failing in the unsafe
    // direction on the one control that stops a message reaching the wrong client.
    setScopeSiblingIds(new Set())
    let alive = true
    // ONLY the account→members direction. The reverse (contact → every company that
    // person belongs to) was too wide: a client with two LLCs got NO mismatch warning
    // when a message drafted for Acme was aimed at Beta, and every Beta member would
    // have seen it. Antonio's ruling is company ↔ ITS member, not "anything this person
    // touches". With no account proposed there is nothing to widen from, so a different
    // id stays a mismatch — the safe direction.
    if (!accId) { setScopeSiblingIds(new Set()); return }
    fetch(`/api/inbox/client-scope-siblings?account_id=${accId}`)
      .then(r => {
        // An error BODY is not an empty result. Unchecked, a 403 reads as "no
        // siblings", which silently turns every legitimate member pick into a
        // mismatch warning with no explanation anywhere.
        if (!r.ok) throw new Error(String(r.status))
        return r.json()
      })
      .then((d: { ids?: string[] }) => { if (alive) setScopeSiblingIds(new Set(d.ids ?? [])) })
      .catch(() => { if (alive) setScopeSiblingIds(new Set()) })
    return () => { alive = false }
  }, [preparedSend?.kind, preparedSend?.proposedAccountId, preparedSend?.proposedContactId])

  const sameClientDifferentScope = Boolean(portalTarget && scopeSiblingIds.has(portalTarget.id))

  const recipientMismatch = Boolean(
    preparedSend?.kind === 'portal' &&
      portalTarget &&
      (preparedSend.proposedAccountId || preparedSend.proposedContactId) &&
      portalTarget.id !== preparedSend.proposedAccountId &&
      portalTarget.id !== preparedSend.proposedContactId &&
      // NOT a mismatch when the staff member is choosing the SCOPE rather than a
      // different client — the worker proposed the company and they picked a member of
      // it, or the reverse. Antonio, 2026-07-31: "If Luca will choose company, the
      // message will go to the company! If Luca will choose the member of a company, it
      // will go to the member." Blocking that told him the message "was written for Acme
      // LLC, not Mario Rossi" — false, and it locked Confirm on the very choice the
      // exact-recipient rule exists to support.
      !sameClientDifferentScope,
  )

  useEffect(() => {
    if (!portalTarget) { setReach({ checking: false, reachable: null }); return }
    let alive = true
    setReach({ checking: true, reachable: null })
    fetch(`/api/inbox/portal-reachability?type=${portalTarget.type}&id=${encodeURIComponent(portalTarget.id)}`)
      .then(async r => {
        if (!r.ok) throw new Error(String(r.status))
        return r.json()
      })
      .then(d => { if (alive) setReach({ checking: false, ...d }) })
      // A failed CHECK must not read as "unreachable" — that would block a legitimate
      // send with no explanation. Allow, and say the check could not run.
      .catch(() => { if (alive) setReach({ checking: false, reachable: true, reason: undefined }) })
    return () => { alive = false }
  }, [portalTarget])

  const gmailThreadId = conversation.id.replace('gmail:', '')

  // Restore the recorded conversation on open — like opening a Slack thread.
  useEffect(() => {
    let alive = true
    const params = new URLSearchParams({ gmailThreadId })
    if (mailbox) params.set('mailbox', mailbox)
    fetch(`/api/inbox/worker-chat?${params}`)
      .then(r => r.json())
      .then((data: { turns?: Array<{ user: string; worker: string | null }> }) => {
        if (!alive || !data.turns?.length) return
        const restored: ChatMsg[] = []
        for (const t of data.turns) {
          restored.push({ role: 'user', text: t.user })
          if (t.worker) restored.push({ role: 'worker', text: t.worker })
        }
        setMessages(restored)
        sentContextRef.current = true // context already recorded on turn 1
      })
      .catch(() => {})
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gmailThreadId])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, pending])

  useEffect(() => {
    if (!pending) { setElapsed(0); return }
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [pending])

  /**
   * `localeOverride` exists because React state is not readable in the same tick it
   * is set. The language dropdown calls setPortalLocale(next) and then send(...) in
   * one handler, so `portalLocale` in this closure is still the PREVIOUS value —
   * which recorded a frozen Italian message as English on its very first live run.
   * The chosen language reaches a client-facing message, so it is passed explicitly
   * rather than read back from state.
   */
  const send = async (text: string, attachments: UploadedAttachment[], localeOverride?: 'en' | 'it') => {
    if (!text || pending) return
    const shown = attachments.length
      ? `${text}\n\n📎 ${attachments.map(a => a.name).join(', ')}`
      : text
    setMessages(prev => [...prev, { role: 'user', text: shown }])
    setPending(true)
    try {
      const res = await fetch('/api/inbox/worker-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          gmailThreadId,
          mailbox,
          ...(attachments.length ? { attachments } : {}),
          // The language the card is set to. Sent on EVERY turn, so a portal message
          // the worker prepares is written in the language the staff member picked —
          // not the language the two of them happen to be speaking.
          portalLocale: localeOverride ?? portalLocale,
          // Email context only on the panel's first message — the worker's
          // persistent thread memory carries it afterwards.
          context: sentContextRef.current
            ? null
            : {
                subject: conversation.subject,
                sender: conversation.name,
                mailbox: mailbox === 'antonio' ? 'antonio' : 'support',
                latestMessage: conversation.preview,
              },
        }),
      })
      const raw = await res.text()
      let data: {
        reply?: string
        error?: string
        preparedSend?: PreparedSend | null
        artifacts?: unknown
      } = {}
      try { data = JSON.parse(raw) } catch { /* non-JSON = gateway error */ }
      if (!res.ok) {
        throw new Error(
          data.error ||
          (res.status === 504
            ? 'The worker ran out of time (over 5 minutes) — ask a narrower question or try again.'
            : `Worker error ${res.status} — please try again.`)
        )
      }
      sentContextRef.current = true
      // Off-thread recipient confirm (per-message button) — the other feature.
      setMessages(prev => [...prev, {
        role: 'worker',
        text: data.reply || '(empty reply)',
        // Parsed through the shared helper so a malformed payload can never throw
        // inside the render — a bad entry is dropped, not shown as a dead button.
        artifacts: parseWorkerArtifacts(data.artifacts),
      }])
      // Attachment confirm (Confirm & send box) — this feature.
      // ?? null so a turn that prepares NOTHING clears a previous card — otherwise a
      // stale frozen email stays on screen under a new conversation and Confirm sends it.
      setLocaleRollback(null)
      setPreparedSend(data.preparedSend ?? null)
      // Fresh card → fresh choice, back to this thread's own mailbox — and the
      // signature back to the default, so one email's "no signature" pick can
      // never silently carry onto the next.
      if (data.preparedSend) {
        setSendAs(mailbox === 'antonio' ? 'antonio' : 'support')
        setSignatureVariant(DEFAULT_SIGNATURE_VARIANT)
      }
      // A NEW portal draft means a new decision. Clearing the picked client forces the
      // staff member to choose again rather than inheriting a selection made against
      // wording that has since been rewritten — the "I approved a different message"
      // failure, one level up.
      if (data.preparedSend?.kind === 'portal') {
        setPortalTarget(null)
        setClientQuery('')
        setClientResults([])
        setReformulateText('')
      }
    } catch (err) {
      // The card still holds the PREVIOUS language's text, so the dropdown must go back
      // to match it. Otherwise the control says Italian, the message is English, Confirm
      // is live, and English goes to the client.
      setLocaleRollback(prev => {
        if (prev) {
          setPortalLocale(prev)
          try { window.localStorage.setItem(localeKey, prev) } catch { /* private mode */ }
        }
        return null
      })
      setMessages(prev => [
        ...prev,
        { role: 'worker', text: `⚠️ ${err instanceof Error && err.message ? err.message : 'Worker failed — please try again.'}` },
      ])
    } finally {
      setPending(false)
    }
  }

  return (
    <WorkerDropZone
      onFiles={files => void attachments.add(files)}
      disabled={pending}
      className="w-full sm:w-[420px] shrink-0 border-l bg-white flex flex-col min-h-0"
    >
      <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-violet-50/60 shrink-0">
        <Bot className="h-4 w-4 text-violet-600 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-900">Worker</p>
          <p className="text-[11px] text-zinc-500 truncate">
            Reads CRM, DB &amp; memory — about: {conversation.subject || conversation.name}
          </p>
        </div>
        <WorkerSettingsGear className="shrink-0" />
        <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100 text-zinc-400" title="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && !pending && (
          <div className="text-xs text-zinc-400 px-2 py-4 text-center space-y-1">
            <p>Same worker as Slack — it checks the CRM, database and its memory before answering.</p>
            <p>Try: &quot;who is this client and what&apos;s open with them?&quot; or &quot;draft a reply&quot;.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={cn('flex flex-col', m.role === 'user' ? 'items-end' : 'items-start')}>
            <div
              className={cn(
                'max-w-[90%] rounded-2xl px-3.5 py-2 text-sm break-words',
                m.role === 'user'
                  ? 'bg-violet-600 text-white rounded-br-md whitespace-pre-wrap'
                  : 'bg-zinc-100 text-zinc-900 rounded-bl-md'
              )}
            >
              {m.role === 'worker' ? <WorkerMarkdown text={m.text} /> : m.text}
              {/* Produced files, from server data — present whatever the reply says. */}
              {m.role === 'worker' ? <WorkerArtifactLinks artifacts={m.artifacts} /> : null}
            </div>
          </div>
        ))}
        {pending && (
          <div className="flex items-center gap-2 text-xs text-zinc-400 px-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Working — checking CRM/DB/memory… {elapsed}s
          </div>
        )}
      </div>

      {/* PORTAL CARD — the client and the language are chosen HERE, then confirmed.
          Separate from the email card below because almost nothing is shared: no
          address, no subject, no mailbox, and a recipient that does not exist until
          the staff member picks one. */}
      {preparedSend && preparedSend.kind === 'portal' && (
        <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 shrink-0">
          <p className="text-[11px] font-semibold text-amber-800 uppercase tracking-wide mb-2">
            Send to the client&apos;s portal chat — confirm before sending
          </p>

          {/* WHO. The most important control on the card: this screen does not fix the
              client, so this choice IS the safety. */}
          {portalTarget ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-white px-2.5 py-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-zinc-900 truncate">{portalTarget.name}</p>
                <p className="text-[11px] text-zinc-500">
                  {portalTarget.type === 'account'
                    ? 'Company — every member of this company will see this message'
                    : "Person — goes to this person's own portal chat"}
                  {portalTarget.detail ? ` · ${portalTarget.detail}` : ''}
                </p>
              </div>
              <button
                onClick={() => { setPortalTarget(null); setClientQuery('') }}
                disabled={confirming}
                className="ml-auto shrink-0 text-xs text-zinc-500 underline hover:text-zinc-800 disabled:opacity-50"
              >
                Change
              </button>
            </div>
          ) : (
            <div>
              <input
                value={clientQuery}
                onChange={e => setClientQuery(e.target.value)}
                disabled={confirming}
                placeholder="Type the client's name — company, person or lead…"
                className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-800 placeholder:text-zinc-400 disabled:opacity-50"
              />
              {/* The worker's guess, offered rather than applied. */}
              {preparedSend.proposedName && !clientQuery ? (
                <button
                  onClick={() =>
                    setPortalTarget({
                      type: preparedSend.proposedAccountId ? 'account' : 'contact',
                      id: (preparedSend.proposedAccountId || preparedSend.proposedContactId) as string,
                      name: preparedSend.proposedName as string,
                    })
                  }
                  className="mt-1.5 text-xs text-blue-700 underline hover:text-blue-900"
                >
                  Suggested: {preparedSend.proposedName} — click to use
                </button>
              ) : null}
              {searching ? <p className="mt-1.5 text-xs text-zinc-500">Searching…</p> : null}
              {clientResults.length ? (
                <div className="mt-1.5 max-h-36 overflow-y-auto rounded-lg border border-zinc-200 bg-white">
                  {clientResults.map(t => (
                    <button
                      key={`${t.type}-${t.id}`}
                      onClick={() => {
                        // Leads are NO LONGER refused here. That refusal was wrong:
                        // sending an offer creates a portal login for the person and
                        // hangs it on a CONTACT, so the same human appears in this list
                        // twice and the contact can receive messages. The reachability
                        // check below resolves a lead to that contact, and only refuses
                        // when there genuinely is no portal login to reach.
                        setPortalTarget(t)
                        setClientResults([])
                      }}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-zinc-50"
                    >
                      <span className="text-sm text-zinc-800 truncate">{t.name}</span>
                      <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-zinc-400">
                        {t.type === 'account' ? 'Company' : t.type}
                      </span>
                      {/* Two clients with near-identical names are one click apart, so
                          show whatever distinguishes them. */}
                      {t.detail ? <span className="shrink-0 text-[11px] text-zinc-500">{t.detail}</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )}

          {/* WHO ACTUALLY RECEIVES IT, AND WHETHER THEY HAVE EVER SIGNED IN.
              Antonio, 2026-08-02. Two failures this replaces, found the same day:
              a LEAD was refused outright ("there's no portal chat") while that same
              person's contact — carrying their portal login, created when the offer
              was sent — sat in the same search list; and a contact with NO portal at
              all was fully sendable, producing a "you have a new message" email to a
              portal they cannot open. */}
          {portalTarget && (
            <div className="mt-1.5 text-[11px]">
              {reach.checking ? (
                <span className="text-zinc-500">Checking portal access…</span>
              ) : reach.reachable === false ? (
                <span className="text-red-700">{reach.reason}</span>
              ) : reach.recipients?.length ? (
                <div className="text-zinc-600">
                  {reach.resolvedName ? (
                    <span className="text-blue-700">Sending to {reach.resolvedName}&apos;s portal. </span>
                  ) : null}
                  {reach.recipients.map((r, i) => (
                    <span key={i}>
                      {i > 0 ? ' · ' : ''}
                      {r.name ?? r.email}
                      {r.lastSignInAt
                        ? ` (last signed in ${new Date(r.lastSignInAt).toLocaleDateString()})`
                        : ' (has access, never signed in)'}
                    </span>
                  ))}
                  {reach.neverSignedIn ? (
                    <span className="text-amber-700">
                      {' '}— nobody here has ever opened the portal, so they may not see this.
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}

          {/* LANGUAGE. Switching it REWRITES the message on the card straight away.
              Antonio, 2026-08-01: "it's better if when we switch language in the dropdown
              we have it in the selected language instead of asking to reformulate."
              (This supersedes his earlier "it's just a drop-down" — as a plain setting it
              only affected the NEXT draft, which meant switching to Italian and then
              having to ask for a rewrite as a second step.)
              Costs a round trip per switch, so it is disabled while a send is in flight
              or a turn is already running — otherwise a toggle mid-confirm races the send
              and could deliver the version the staff member just switched away from. */}
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="text-zinc-500">Language:</span>
            <select
              value={portalLocale}
              onChange={e => {
                const next = e.target.value as 'en' | 'it'
                if (next === portalLocale) return
                const previous = portalLocale
                setPortalLocale(next)
                try { window.localStorage.setItem(localeKey, next) } catch { /* private mode */ }
                // If the rewrite never lands (timeout, the per-thread in-flight 409 when a
                // colleague has the same email open, a worker error), the card still shows
                // the OLD language while the dropdown claims the new one — and Confirm
                // would ship the language the dropdown says it is not. Put the dropdown
                // back so the card and the control cannot disagree.
                setLocaleRollback(() => previous)
                // Rewrite in the chosen language. Goes through the worker as a normal
                // turn, so it freezes a NEW draft and supersedes this one — the version
                // in the old language can never be the one that ships.
                send(
                  `Rewrite the portal message in ${next === 'it' ? 'Italian' : 'English'}. Keep the same meaning and length. Then prepare it again.`,
                  [],
                  next,
                )
              }}
              disabled={confirming || pending}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-800 disabled:opacity-50"
            >
              <option value="en">English</option>
              <option value="it">Italian</option>
            </select>
            <span className="text-zinc-400">
              {pending ? 'rewriting…' : 'switching rewrites the message'}
            </span>
          </div>

          {/* THE MESSAGE — exactly what will be sent. */}
          <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-amber-200 bg-white px-2.5 py-2">
            <p className="whitespace-pre-wrap break-words text-xs text-zinc-700">{preparedSend.body}</p>
          </div>

          {/* THE LABEL MUST NOT BE ABLE TO LIE. Observed 2026-08-02: dropdown on
              English, message in Italian, because the worker copied earlier turns
              instead of following the setting it was told. Detected server-side with
              the existing EN/IT detector, which stays silent on short or mixed text —
              so this fires only when the text is confidently the wrong language. */}
          {preparedSend.languageMismatch ? (
            <div className="mt-2 rounded-lg border border-red-300 bg-red-50 px-2.5 py-2">
              <p className="text-xs font-semibold text-red-800">
                This message is in {preparedSend.languageMismatch === 'it' ? 'Italian' : 'English'}, but the
                language is set to {portalLocale === 'it' ? 'Italian' : 'English'}.
              </p>
              <p className="mt-0.5 text-[11px] text-red-700">
                Switch the dropdown to match, or press Reformulate to rewrite it in{' '}
                {portalLocale === 'it' ? 'Italian' : 'English'}.
              </p>
            </div>
          ) : null}

          {/* MISMATCH BACKSTOP. The message is written BEFORE the client is chosen, so
              a name inside it is a guess the card cannot correct — and correcting it
              server-side would edit text after a human approved it, which is the one
              thing this card exists to prevent. On 2026-07-31 a message opening
              "Hi Uxio" was delivered to a different client because the recipient was
              changed here and the words could not follow.
              The real fix is the prompt rule telling the worker not to put a client
              name in the message at all; this catches what that misses. It fires only
              when the worker actually proposed someone — a name invented inside the
              text with no proposal is invisible here, which is why the prompt rule,
              not this, is the primary control. */}
          {recipientMismatch ? (
            <div className="mt-2 rounded-lg border border-red-300 bg-red-50 px-2.5 py-2">
              <p className="text-xs font-semibold text-red-800">
                This message was written for {preparedSend.proposedName}, not {portalTarget?.name}.
              </p>
              <p className="mt-0.5 text-[11px] text-red-700">
                It may name the wrong client. Press Reformulate so the assistant rewrites it for{' '}
                {portalTarget?.name}, then send.
              </p>
            </div>
          ) : null}

          {/* REFORMULATE. Goes back through the worker as a normal turn, which freezes
              a NEW draft and cancels this one — so the wording that was rejected can
              never be the wording that ships. Disabled while a send is in flight:
              otherwise a slow Confirm plus an impatient rewrite delivers both. */}
          {reformulating ? (
            <div className="mt-2">
              <input
                value={reformulateText}
                onChange={e => setReformulateText(e.target.value)}
                placeholder="What should change? e.g. shorter, warmer, don't mention the rejection"
                className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-800 placeholder:text-zinc-400"
                onKeyDown={e => {
                  if (e.key === 'Enter' && reformulateText.trim()) {
                    const t = reformulateText.trim()
                    setReformulating(false)
                    setReformulateText('')
                    send(
                      // Names the CHOSEN client when one is picked, so a rewrite
                      // triggered by the mismatch warning actually lands on the right
                      // person. Without it the worker rewrites blind and can repeat
                      // the wrong name.
                      portalTarget
                        ? `Rewrite the portal message that is going to ${portalTarget.name}: ${t}. Then prepare it again.`
                        : `Rewrite the portal message for the client: ${t}. Then prepare it again.`,
                      [],
                    )
                  }
                }}
              />
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  onClick={() => {
                    const t = reformulateText.trim()
                    if (!t) return
                    setReformulating(false)
                    setReformulateText('')
                    send(
                      // Names the CHOSEN client when one is picked, so a rewrite
                      // triggered by the mismatch warning actually lands on the right
                      // person. Without it the worker rewrites blind and can repeat
                      // the wrong name.
                      portalTarget
                        ? `Rewrite the portal message that is going to ${portalTarget.name}: ${t}. Then prepare it again.`
                        : `Rewrite the portal message for the client: ${t}. Then prepare it again.`,
                      [],
                    )
                  }}
                  disabled={!reformulateText.trim() || pending}
                  className="px-3 py-1.5 rounded-lg bg-zinc-800 text-white text-sm font-medium hover:bg-zinc-900 disabled:opacity-50"
                >
                  Rewrite
                </button>
                <button
                  onClick={() => { setReformulating(false); setReformulateText('') }}
                  className="px-3 py-1.5 rounded-lg border border-zinc-300 text-zinc-700 text-sm hover:bg-zinc-100"
                >
                  Back
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                onClick={() => resolvePreparedSend('confirm')}
                // `pending` is LOAD-BEARING, not tidiness. A rewrite (language switch or
                // Reformulate) runs as a worker turn taking 20-60s. Without this, an
                // impatient click during that window confirms the row that is still
                // pending — delivering the PRE-rewrite text — and then the rewrite lands,
                // renders a second card, and the same message goes out again in the other
                // language. Supersede cannot save it: it only cancels rows still pending,
                // and the first one is already sent.
                disabled={
                  confirming ||
                  pending ||
                  !portalTarget ||
                  recipientMismatch ||
                  // Wait for the access check rather than letting a click race it, and
                  // never allow a send to someone who cannot open the portal — they
                  // would get a "you have a new message" email pointing at a door they
                  // have no key to, and nobody would ever read the message.
                  reach.checking ||
                  reach.reachable === false ||
                  // Never send text whose language disagrees with the card's own label.
                  !!preparedSend.languageMismatch
                }
                title={
                  !portalTarget
                    ? 'Choose which client this goes to first'
                    : recipientMismatch
                      ? 'This message was written for a different client — rewrite it first'
                      : undefined
                }
                className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
              >
                {confirming ? 'Sending…' : 'Confirm & send'}
              </button>
              <button
                onClick={() => setReformulating(true)}
                disabled={confirming || pending}
                className="px-3 py-1.5 rounded-lg border border-zinc-300 text-zinc-700 text-sm hover:bg-zinc-100 disabled:opacity-50"
              >
                Reformulate
              </button>
              <button
                onClick={() => resolvePreparedSend('cancel')}
                disabled={confirming}
                className="px-3 py-1.5 rounded-lg border border-zinc-300 text-zinc-700 text-sm hover:bg-zinc-100 disabled:opacity-50"
              >
                Cancel
              </button>
              {!portalTarget ? (
                <span className="text-xs text-amber-800">Choose the client to enable sending.</span>
              ) : null}
            </div>
          )}
        </div>
      )}

      {preparedSend && preparedSend.kind !== 'portal' && (
        <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 shrink-0">
          <p className="text-[11px] font-semibold text-amber-800 uppercase tracking-wide mb-1">Confirm before sending</p>
          <p className="text-sm text-zinc-800">
            Email <span className="font-mono font-medium break-all">{preparedSend.to}</span>
          </p>
          {preparedSend.subject ? (
            <p className="text-xs text-zinc-600 mt-0.5">Subject: {preparedSend.subject}</p>
          ) : null}
          {/* THE MESSAGE ITSELF. Confirming an address without seeing the body is
              how someone approves one draft while a different one goes out — the
              exact failure the frozen-payload path exists to remove. Scrollable
              rather than truncated: a cut-off body hides the part worth checking. */}
          {preparedSend.body ? (
            <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-amber-200 bg-white px-2.5 py-2">
              <p className="whitespace-pre-wrap break-words text-xs text-zinc-700">{preparedSend.body}</p>
            </div>
          ) : null}
          <ConfirmAttachments
            preparedId={preparedSend.id}
            attachments={preparedSend.attachments}
            className="mt-1.5 space-y-1.5"
            onChange={files => setPreparedSend(p => (p ? { ...p, attachments: files } : p))}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-zinc-500">From:</span>
            <select
              value={sendAs}
              onChange={e => {
                const next = e.target.value as 'support' | 'antonio'
                setSendAs(next)
                // Coerce the STATE, not just the display: "hat" isn't on offer
                // for support, and the picker's visual fallback would otherwise
                // show "Full" while the POST still carries "hat" (harmless today
                // — support renders both identically — but a lie in waiting).
                if (next === 'support' && signatureVariant === 'hat') setSignatureVariant('gala')
              }}
              disabled={confirming}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-800 disabled:opacity-50"
            >
              <option value="support">support@tonydurante.us</option>
              <option value="antonio">antonio.durante@tonydurante.us</option>
            </select>
            {/* Same per-email chooser as manual compose/reply (Luca's request,
                Antonio approved 2026-08-07). The mailbox stays in the dropdown
                above, so only the signature select renders here. */}
            <SignatureControls
              sender={sendAs}
              variant={signatureVariant}
              onVariantChange={setSignatureVariant}
              disabled={confirming}
            />
          </div>
          {/* The chooser is blind without this — the signature is attached
              server-side (same reason compose/reply preview it). Scrolls so the
              full variant can't swallow the card on the phone PWA. */}
          <div className="mt-2 max-h-36 overflow-y-auto">
            <SignaturePreview sender={sendAs} variant={signatureVariant} authorWritesClosing={false} />
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              onClick={() => resolvePreparedSend('confirm')}
              disabled={confirming}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
            >
              {confirming ? 'Sending…' : 'Confirm & send'}
            </button>
            <button
              onClick={() => resolvePreparedSend('cancel')}
              disabled={confirming}
              className="px-3 py-1.5 rounded-lg border border-zinc-300 text-zinc-700 text-sm hover:bg-zinc-100 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <WorkerComposer
        placeholder="Ask the worker about this email…"
        pending={pending}
        value={input}
        onChange={setInput}
        onSend={send}
        attachments={attachments}
      />
    </WorkerDropZone>
  )
}
