'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { isBeingViewed } from '@/lib/talk/window-front'
import { isFrameHidden } from '@/lib/marketing/frame-visibility'
import { uploadLeadAttachment } from '@/lib/marketing/lead-chat-upload'
import {
  dayLabel, matchMessages, mergeSnapshot, messageSignature, parseTypingSignal, shouldAnnounceTyping, snippet, tickStateAll, timeLabel, TYPING_EXPIRES_MS,
  type TalkMessage, type TalkReaction, type TypingKind,
} from '@/lib/talk/chat-model'
import { TalkMessages, TalkMentionNames } from '@/components/talk/talk-messages'
import { TalkComposer, type TalkComposerMode, type TalkSendInput } from '@/components/talk/talk-composer'
import { TalkMessageSheet } from '@/components/talk/talk-sheet'
import { STATIC_SNIPPETS, TalkI18nProvider, type TalkI18n } from '@/components/talk/talk-i18n'
import { URL_REFRESH_SECONDS } from '@/lib/marketing/lead-chat'
import { useLang, useT } from '@/components/marketing/lang-provider'
import { localeFor } from '@/lib/marketing/i18n'

const POLL_MS = 4_000

/**
 * The chat inside a lead (dev job 9aec66fa, Addendum G): the setter and the seller talk about THIS lead. The screen is TD Talk's own — the same message list, composer
 * (text, photos, files, voice notes) and long-press menu (reactions, reply, copy, edit, delete) — fed with this chat's data through /api/marketing/chat, so everything TD Talk
 * can do is here, and what TD Talk gains later arrives here with it. New messages come in by a short refresh while the window is open; "typing…" is live.
 * READ RULE (TD Talk's): messages are marked read only while somebody is looking at the window.
 */
export function LeadChat({ leadId }: { leadId: string }) {
  return <ConversationChat id={leadId} api="/api/marketing/chat" idField="lead_id" channel="tdm-lead-typing" />
}

/** The chat of a team conversation (a direct message or a group): the same screen, fed by /api/marketing/team-chat. */
export function TeamChat({ threadId }: { threadId: string }) {
  return <ConversationChat id={threadId} api="/api/marketing/team-chat" idField="thread_id" channel="tdm-team-typing" />
}

/**
 * One conversation, whatever it is about: a lead, a direct message, a group. `api` is the chat's own address (it answers the same shape everywhere), `idField` names the id in the
 * "delivered" call, `channel` the live "typing…" channel. Everything below is the lead chat's own code, only not tied to a lead any more.
 */
function ConversationChat({ id: leadId, api: API, idField, channel: typingPrefix }: { id: string; api: string; idField: 'lead_id' | 'thread_id'; channel: string }) {
  const VOICE_API = `${API}/messages`
  const t = useT()
  const lang = useLang()
  const tRef = useRef(t)
  tRef.current = t
  // the words of TD Talk's screen in the person's language; a day further back than yesterday is written by the browser in that language
  const i18n = useMemo<TalkI18n>(() => ({
    t,
    ts: text => (STATIC_SNIPPETS.has(text) ? t(text) : text),
    day: (label, iso) => (label === 'Today' || label === 'Yesterday' ? t(label) : new Intl.DateTimeFormat(localeFor(lang), { weekday: 'short', day: 'numeric', month: 'short', ...(new Date(iso).getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) }).format(new Date(iso))),
  }), [t, lang])
  const [messages, setMessages] = useState<TalkMessage[]>([])
  const [meId, setMeId] = useState<string | null>(null)
  const [others, setOthers] = useState<string[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [reads, setReads] = useState<Record<string, string>>({})
  const [delivered, setDelivered] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sheetMsg, setSheetMsg] = useState<TalkMessage | null>(null)
  const [mode, setMode] = useState<TalkComposerMode>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [peerTyping, setPeerTyping] = useState<{ userId: string; kind: TypingKind } | null>(null)
  const messagesRef = useRef<TalkMessage[]>([])
  const meIdRef = useRef<string | null>(null)
  const typingChannelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null)
  const typingSentAtRef = useRef<number | null>(null)
  const deliveredFor = useRef<string | null>(null)
  // when the file links on screen were fetched: a window left open asks for fresh ones before they run out (an hour), and a refresh that changes nothing else keeps the audio player undisturbed
  const linksAtRef = useRef(0)
  const failuresRef = useRef(0)
  // after "Mark unread" this open window must not read the chat again by itself (it would undo it at the next refresh); a fresh open reads as usual
  const heldUnreadRef = useRef(false)
  // the refresh that is running right now: "Mark unread" waits for it, so a refresh that was already on its way (and would read the chat) cannot land after the mark
  const inflightRef = useRef<Promise<void> | null>(null)
  const hiddenSince = useRef(false)
  const [offline, setOffline] = useState(false)
  messagesRef.current = messages
  meIdRef.current = meId

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    try {
      const r = await fetch(`${API}/${leadId}${isBeingViewed() && !isFrameHidden() && !heldUnreadRef.current ? '' : '?mark_read=0'}`)
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(tRef.current(d.error || 'Could not load this chat.')) }
      const d = await r.json()
      const incoming = (d.messages ?? []) as TalkMessage[]
      setMeId(d.me ?? null); meIdRef.current = d.me ?? null
      setOthers(d.member_ids ?? [])
      setNames(Object.fromEntries(((d.members ?? []) as Array<{ id: string; name: string }>).map(m => [m.id, m.name])))
      setReads(Object.fromEntries(((d.member_reads ?? []) as Array<{ user_id: string; last_read_at: string }>).map(x => [x.user_id, x.last_read_at])))
      setDelivered(Object.fromEntries(((d.member_delivered ?? []) as Array<{ user_id: string; delivered_at: string }>).map(x => [x.user_id, x.delivered_at])))
      const linksStale = Date.now() - linksAtRef.current > URL_REFRESH_SECONDS * 1000
      setMessages(prev => {
        // MERGE, never replace (TD Talk's rule): a slow refresh that answers after a send must not wipe the new message
        const merged = mergeSnapshot(prev, incoming)
        if (opts.silent && !linksStale && messageSignature(merged) === messageSignature(prev)) return prev
        linksAtRef.current = Date.now()
        return merged
      })
      failuresRef.current = 0; setOffline(false)
      setLoadError(null)
      // this device now HAS the chat: tell the others (grey double tick), once per newest message
      const newest = incoming.filter(m => m.sender_id !== d.me).map(m => m.created_at).sort().pop() ?? null
      if (newest && deliveredFor.current !== newest) {
        deliveredFor.current = newest
        void fetch(`${API}/delivered`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ [idField]: leadId }] }), keepalive: true }).catch(() => { deliveredFor.current = null })
      }
    } catch (e) {
      // a refresh that fails in the background used to be invisible: after three in a row the chat says so
      if (opts.silent && ++failuresRef.current >= 3) setOffline(true)
      if (!opts.silent) setLoadError(e instanceof Error ? e.message : tRef.current('Could not load this chat.'))
    } finally {
      setLoading(false)
    }
  }, [leadId, API, idField])

  const loadTracked = useCallback((opts: { silent?: boolean } = {}) => {
    const p = load(opts).finally(() => { if (inflightRef.current === p) inflightRef.current = null })
    inflightRef.current = p
    return p
  }, [load])
  useEffect(() => { void loadTracked() }, [loadTracked])

  // a short refresh while the window is open and on screen, and a catch-up when it comes back to the front
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') void loadTracked({ silent: true }) }
    const timer = setInterval(tick, POLL_MS)
    // coming back to a window that was hidden is opening the chat again: a held "Mark unread" lets go (the next refresh reads it)
    const back = () => { if (document.visibilityState === 'visible' && hiddenSince.current) { hiddenSince.current = false; heldUnreadRef.current = false } else if (document.visibilityState === 'hidden') hiddenSince.current = true }
    document.addEventListener('visibilitychange', back)
    document.addEventListener('visibilitychange', tick)
    window.addEventListener('focus', tick)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', back); document.removeEventListener('visibilitychange', tick); window.removeEventListener('focus', tick) }
  }, [loadTracked])

  // "typing…": a lightweight broadcast on a per-lead channel (nothing is stored), exactly TD Talk's mechanism
  useEffect(() => {
    setPeerTyping(null)
    typingSentAtRef.current = null
    const supabase = createClient()
    let expire: ReturnType<typeof setTimeout> | null = null
    const channel = supabase
      .channel(`${typingPrefix}-${leadId}`, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        const sig = parseTypingSignal(payload, meIdRef.current)
        if (!sig) return
        setPeerTyping({ userId: sig.userId, kind: sig.kind })
        if (expire) clearTimeout(expire)
        expire = setTimeout(() => setPeerTyping(null), TYPING_EXPIRES_MS)
      })
      .subscribe()
    typingChannelRef.current = channel
    return () => { if (expire) clearTimeout(expire); typingChannelRef.current = null; void supabase.removeChannel(channel) }
  }, [leadId, typingPrefix])

  const announceTyping = useCallback((kind: TypingKind) => {
    const now = Date.now()
    if (!shouldAnnounceTyping(typingSentAtRef.current, now)) return
    typingSentAtRef.current = now
    void typingChannelRef.current?.send({ type: 'broadcast', event: 'typing', payload: { user_id: meIdRef.current, kind } })
  }, [])

  const send = useCallback(async ({ text, files, replyToId }: TalkSendInput): Promise<boolean> => {
    const voiceOnly = !text && files.length === 1 && files[0].type.startsWith('audio/')
    try {
      const attachments = []
      for (const f of files) attachments.push(await uploadLeadAttachment(f, leadId, API))
      const r = await fetch(`${API}/${leadId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, reply_to_id: replyToId ?? null, attachments: attachments.length ? attachments : null }) })
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Could not send. Please try again.') }
      const d = await r.json().catch(() => null)
      if (d?.message) setMessages(prev => prev.some(x => x.id === d.message.id) ? prev : [...prev, d.message as TalkMessage])
      // answering is dealing with the chat: the server reads it, so the hold lets go too
      heldUnreadRef.current = false
      return true
    } catch (e) {
      const why = t(e instanceof Error && e.message ? e.message : 'Could not send. Please try again.')
      toast.error(voiceOnly ? `${why} ${t('Please record the voice message again.')}` : why)
      return false
    }
  }, [leadId, t, API])

  const applyToMessage = useCallback((id: string, patch: Partial<TalkMessage>) => setMessages(prev => prev.map(m => (m.id === id ? { ...m, ...patch } : m))), [])

  const react = useCallback(async (m: TalkMessage, emoji: string) => {
    setSheetMsg(null)
    try {
      const r = await fetch(`${VOICE_API}/${m.id}/react`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(t(d.error || 'Could not react.'))
      if (Array.isArray(d.reactions)) applyToMessage(m.id, { reactions: d.reactions as TalkReaction[] })
    } catch (e) { toast.error(e instanceof Error ? e.message : t('Could not react.')) }
  }, [applyToMessage, t, VOICE_API])

  const copyText = useCallback(async (m: TalkMessage) => {
    setSheetMsg(null)
    try { await navigator.clipboard.writeText(m.message); toast.success(t('Copied')) } catch { toast.error(t('Could not copy.')) }
  }, [t])

  const edit = useCallback(async (id: string, text: string): Promise<boolean> => {
    if (!text.trim()) { toast.error(t('A message cannot be empty. Delete it instead.')); return false }
    try {
      const r = await fetch(`${VOICE_API}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(t(d.error || 'Could not edit the message.'))
      if (d.message) applyToMessage(id, { message: d.message.message, edited_at: d.message.edited_at })
      return true
    } catch (e) { toast.error(e instanceof Error ? e.message : t('Could not edit the message.')); return false }
  }, [applyToMessage, t, VOICE_API])

  const remove = useCallback(async (m: TalkMessage) => {
    setSheetMsg(null)
    try {
      const r = await fetch(`${VOICE_API}/${m.id}`, { method: 'DELETE' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(t(d.error || 'Could not delete the message.'))
      applyToMessage(m.id, { deleted_at: new Date().toISOString() })
      setMode(cur => (cur && cur.message.id === m.id ? null : cur))
    } catch (e) { toast.error(e instanceof Error ? e.message : t('Could not delete the message.')) }
  }, [applyToMessage, t, VOICE_API])

  const markUnread = useCallback(async (m: TalkMessage) => {
    setSheetMsg(null)
    heldUnreadRef.current = true
    await inflightRef.current?.catch(() => undefined)
    try {
      const r = await fetch(`${API}/${leadId}/unread`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message_id: m.id }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(t(d.error || 'Could not mark it unread. Please try again.'))
      toast.success(t('Marked as unread.'))
    } catch (e) { heldUnreadRef.current = false; toast.error(e instanceof Error ? e.message : t('Could not mark it unread. Please try again.')) }
  }, [API, leadId, t])

  const jumpTo = useCallback((id: string) => {
    if (!messagesRef.current.some(m => m.id === id)) { toast(t('That message is older than the latest 500 in this chat.')); return }
    setSearchOpen(false)
    setTimeout(() => {
      document.querySelector(`[data-mid="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setHighlightId(id)
      setTimeout(() => setHighlightId(cur => (cur === id ? null : cur)), 1800)
    }, 120)
  }, [t])

  if (loading && messages.length === 0) return <div className="flex h-full items-center justify-center bg-white"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>
  if (loadError && messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-white px-6 text-center" data-testid="lead-chat-error">
        <p className="text-sm text-zinc-600">{loadError}</p>
        <button type="button" onClick={() => { setLoading(true); void load() }} className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white">{t('Try again')}</button>
      </div>
    )
  }
  // the people of this conversation: who can be named with @, and whose @name is highlighted in the messages
  const mentionPeople = Object.entries(names).filter(([pid]) => pid !== meId).map(([pid, name]) => ({ id: pid, name }))
  const mentionNames = Object.values(names)
  const typingWho = peerTyping ? names[peerTyping.userId] ?? t('Someone') : null
  const typingText = peerTyping ? t(peerTyping.kind === 'recording' ? '{who} is recording a voice message…' : '{who} is typing…', { who: typingWho ?? '' }) : ''
  const tickOf = (m: TalkMessage) => tickStateAll(m, others, reads, delivered)
  const hits = matchMessages(messages, searchQ)
  return (
    <TalkI18nProvider value={i18n}>
    <TalkMentionNames.Provider value={mentionNames}>
    <div className="flex h-full flex-col bg-white" data-testid="lead-chat">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-200 px-3 py-1.5">
        <span className="min-w-0 truncate text-xs text-zinc-500" data-testid="lead-chat-status">
          {peerTyping ? <span className="text-slate-900" data-testid="talk-typing">{typingText}</span> : (others.length > 0 ? `${others.map(id => names[id]).filter(Boolean).join(', ')}` : t('Only you can read this chat for now'))}
        </span>
        <button type="button" onClick={() => { setSearchOpen(o => !o); setSearchQ('') }} aria-label={t('Search this chat')} data-testid="talk-search-toggle" className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 hover:bg-zinc-100">
          {searchOpen ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
        </button>
      </div>
      {offline && <div role="status" className="shrink-0 bg-amber-50 px-3 py-1 text-xs text-amber-900" data-testid="chat-offline">{t('Connection problem. New messages may be late; trying again.')}</div>}
      {searchOpen && (
        <div className="flex min-h-0 flex-1 flex-col bg-white" data-testid="talk-search">
          <div className="shrink-0 border-b border-zinc-200 px-3 py-2">
            <input autoFocus value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder={t('Search this chat')} className="h-9 w-full rounded-full border border-zinc-200 bg-zinc-50 px-4 text-[15px] outline-none" data-testid="talk-search-input" />
            <p className="mt-1 px-2 text-[11px] text-zinc-400">{t('Searches the latest 500 messages in this chat.')}</p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {hits.map(m => (
              <button key={m.id} type="button" onClick={() => jumpTo(m.id)} className="block w-full border-b border-zinc-100 px-4 py-3 text-left hover:bg-zinc-50" data-testid="talk-search-hit">
                <span className="flex justify-between text-xs text-zinc-400"><span>{m.sender_id === meId ? t('You') : m.sender_name}</span><span>{i18n.day(dayLabel(m.created_at), m.created_at)} · {timeLabel(m.created_at)}</span></span>
                <span className="block truncate text-[15px] text-zinc-800">{i18n.ts(snippet(m, 120))}</span>
              </button>
            ))}
            {searchQ.trim().length >= 2 && hits.length === 0 && <p className="px-4 py-8 text-center text-sm text-zinc-400">{t('Nothing found.')}</p>}
          </div>
        </div>
      )}
      {meId && !searchOpen && (
        <TalkMessages
          threadId={leadId} messages={messages} meId={meId} tickOf={tickOf} showSender loading={loading} highlightId={highlightId} voiceApi={VOICE_API}
          onMenu={setSheetMsg}
          onReply={m => { setMode({ kind: 'reply', message: m, who: m.sender_id === meId ? 'yourself' : m.sender_name }); setSheetMsg(null) }}
          onReact={(m, emoji) => void react(m, emoji)}
          onJumpTo={jumpTo}
          tools={{ onEdit: m => { setMode({ kind: 'edit', message: m }); setSheetMsg(null) } }}
        />
      )}
      {!searchOpen && <TalkComposer key={leadId} onSend={send} onEdit={edit} mode={mode} onCancelMode={() => setMode(null)} onTyping={announceTyping} mentionPeople={mentionPeople} />}
      {sheetMsg && meId && (
        <TalkMessageSheet
          message={messages.find(x => x.id === sheetMsg.id) ?? sheetMsg} meId={meId} onClose={() => setSheetMsg(null)}
          onReact={emoji => void react(sheetMsg, emoji)}
          onReply={() => { setMode({ kind: 'reply', message: sheetMsg, who: sheetMsg.sender_id === meId ? 'yourself' : sheetMsg.sender_name }); setSheetMsg(null) }}
          onCopy={() => void copyText(sheetMsg)}
          onEdit={() => { setMode({ kind: 'edit', message: sheetMsg }); setSheetMsg(null) }}
          onDelete={() => void remove(sheetMsg)}
          onMarkUnread={() => void markUnread(sheetMsg)}
        />
      )}
    </div>
    </TalkMentionNames.Provider>
    </TalkI18nProvider>
  )
}
