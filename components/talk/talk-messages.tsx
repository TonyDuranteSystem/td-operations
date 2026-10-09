'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, CheckCheck, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { VoiceNote } from '@/components/team-chat/voice-note'
import {
  formatSize, groupByDay, isAudio, isImage, linkify, nameColorFor, quotedPreview, reactionSummary, timeLabel,
  type TalkAttachment, type TalkMessage,
} from '@/lib/talk/chat-model'

/** One attachment inside a bubble: a voice note you can play, a photo you can open, or a file you can download. */
function Attachment({ a, messageId, index }: { a: TalkAttachment; messageId: string; index: number }) {
  const [broken, setBroken] = useState(false)
  if (isAudio(a) && !broken) {
    return <VoiceNote messageId={messageId} index={index} url={a.url} transcript={a.transcript} onBroken={() => setBroken(true)} />
  }
  if (isImage(a) && !broken) {
    return (
      <a href={a.url} target="_blank" rel="noopener noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={a.url}
          alt={a.name}
          loading="lazy"
          onError={() => setBroken(true)}
          className="max-h-64 max-w-full rounded-lg object-cover"
        />
      </a>
    )
  }
  return (
    <a
      href={a.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white/70 px-3 py-2 text-sm text-zinc-800"
    >
      <FileText className="h-5 w-5 shrink-0 text-zinc-500" />
      <span className="min-w-0 flex-1 truncate">{a.name || 'File'}</span>
      <span className="shrink-0 text-xs text-zinc-500">{isAudio(a) ? 'Open' : formatSize(a.size)}</span>
    </a>
  )
}

function Text({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words text-[15px] leading-snug">
      {linkify(text).map((p, i) =>
        p.href
          ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer" className="underline text-blue-700 break-all">{p.text}</a>
          : <span key={i}>{p.text}</span>,
      )}
    </p>
  )
}

const LONG_PRESS_MS = 450
const SWIPE_TRIGGER_PX = 64

function Bubble({
  m, mine, seen, showSender, meId, byId, highlighted, onMenu, onReply, onReact, onJumpTo,
}: {
  m: TalkMessage; mine: boolean; seen: boolean; showSender: boolean; meId: string; byId: Map<string, TalkMessage>; highlighted: boolean
  onMenu: (m: TalkMessage) => void; onReply: (m: TalkMessage) => void; onReact: (m: TalkMessage, emoji: string) => void; onJumpTo: (id: string) => void
}) {
  const atts = (m.attachments ?? []).filter(a => a && a.url)
  const deleted = !!m.deleted_at
  const quote = quotedPreview(m, byId)
  const pills = reactionSummary(m.reactions, meId)

  // Long-press opens the menu; a swipe to the right replies (WhatsApp). Both are cancelled by any real movement the
  // other way, so scrolling the chat never triggers either.
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> | null; swiped: boolean; fired: boolean; dx: number } | null>(null)
  const [dx, setDx] = useState(0)
  const clear = () => { if (press.current?.timer) clearTimeout(press.current.timer) }
  const onTouchStart = (e: React.TouchEvent) => {
    if (deleted) return
    const t = e.touches[0]
    press.current = { x: t.clientX, y: t.clientY, swiped: false, fired: false, dx: 0, timer: setTimeout(() => { if (press.current) { press.current.fired = true; onMenu(m) } }, LONG_PRESS_MS) }
  }
  const onTouchMove = (e: React.TouchEvent) => {
    const p = press.current
    if (!p) return
    const t = e.touches[0]
    const mx = t.clientX - p.x, my = t.clientY - p.y
    if (Math.abs(mx) > 8 || Math.abs(my) > 8) clear()
    if (!p.fired && mx > 0 && Math.abs(my) < 30 && mx > 12) { p.swiped = true; p.dx = mx; setDx(Math.min(mx, 90)) }
  }
  const onTouchEnd = () => {
    const p = press.current
    clear()
    if (p?.swiped && p.dx >= SWIPE_TRIGGER_PX) onReply(m) // read from the ref: state may not have re-rendered yet
    setDx(0)
    press.current = null
  }

  return (
    <div className={cn('group flex', mine ? 'justify-end' : 'justify-start', pills.length > 0 && !deleted && 'pb-3')} data-mid={m.id}>
      <div
        data-testid={mine ? 'talk-msg-mine' : 'talk-msg-theirs'}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onContextMenu={e => { e.preventDefault(); if (!deleted) onMenu(m) }}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dx ? 'none' : 'transform 150ms' }}
        className={cn(
          'relative max-w-[82%] select-none rounded-2xl px-3 py-2 shadow-sm [-webkit-touch-callout:none] [-webkit-user-select:none]',
          mine ? 'rounded-br-md bg-[#fbe3e5] text-zinc-900' : 'rounded-bl-md border border-zinc-200 bg-white text-zinc-900',
          highlighted && 'ring-2 ring-amber-400',
        )}
      >
        {!deleted && (
          <button
            type="button"
            aria-label="Message options"
            onClick={() => onMenu(m)}
            className="absolute -top-2 right-1 hidden rounded-full bg-white p-1 text-zinc-500 shadow md:group-hover:block"
          >
            <span className="block h-4 w-4 text-center text-xs leading-4">⌄</span>
          </button>
        )}
        {deleted ? (
          <p className="text-sm italic text-zinc-400">This message was deleted</p>
        ) : (
          <div className="space-y-1.5">
            {showSender && !mine && (
              <span className={cn('block text-[13px] font-semibold', nameColorFor(m.sender_id))} data-testid="talk-sender">{m.sender_name}</span>
            )}
            {quote && (
              <button
                type="button"
                onClick={() => onJumpTo(quote.id)}
                data-testid="talk-quote"
                className="block w-full rounded-lg border-l-4 border-[#BE1E2D] bg-black/5 px-2 py-1 text-left"
              >
                {quote.sender_name && <span className="block text-xs font-semibold text-[#BE1E2D]">{quote.sender_name}</span>}
                <span className="block truncate text-[13px] text-zinc-600">{quote.text}</span>
              </button>
            )}
            {atts.map((a, i) => <Attachment key={`${a.url}-${i}`} a={a} messageId={m.id} index={i} />)}
            {m.message ? <Text text={m.message} /> : null}
          </div>
        )}
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-zinc-500">
          {m.edited_at && !deleted && <span>edited</span>}
          <span>{timeLabel(m.created_at)}</span>
          {mine && !deleted && (
            seen
              ? <CheckCheck className="h-3.5 w-3.5 text-sky-600" aria-label="Seen" data-testid="talk-tick-seen" />
              : <Check className="h-3.5 w-3.5 text-zinc-400" aria-label="Sent" data-testid="talk-tick-sent" />
          )}
        </div>
        {pills.length > 0 && !deleted && (
          <div className={cn('absolute -bottom-3 flex gap-1', mine ? 'right-2' : 'left-2')} data-testid="talk-reactions">
            {pills.map(p => (
              <button
                key={p.emoji}
                type="button"
                onClick={() => onReact(m, p.emoji)}
                className={cn('flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-xs shadow-sm', p.mine ? 'border-sky-300 bg-sky-50' : 'border-zinc-200 bg-white')}
              >
                <span>{p.emoji}</span>{p.count > 1 && <span className="text-zinc-600">{p.count}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The conversation: day headings, bubbles (mine on the right), voice notes, photos and files. Stays pinned to the
 * newest message — opens at the bottom, follows a new message when you are already near the bottom (or it is yours),
 * and never yanks you down while you are reading older ones.
 */
export function TalkMessages({
  threadId, messages, meId, isSeen, showSender, loading, highlightId, onMenu, onReply, onReact, onJumpTo,
}: {
  threadId: string; messages: TalkMessage[]; meId: string
  /** Is my message seen (a direct message: the other person read it; a group: everyone did). */
  isSeen: (m: TalkMessage) => boolean
  /** A group shows who wrote each message from someone else. */
  showSender: boolean
  loading: boolean
  highlightId: string | null
  onMenu: (m: TalkMessage) => void; onReply: (m: TalkMessage) => void; onReact: (m: TalkMessage, emoji: string) => void; onJumpTo: (id: string) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const openedRef = useRef<string | null>(null)
  const lastCountRef = useRef(0)

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    if (openedRef.current !== threadId) {
      // first paint of this chat: jump to the newest, no animation
      if (messages.length === 0) return
      openedRef.current = threadId
      lastCountRef.current = messages.length
      el.scrollTop = el.scrollHeight
      return
    }
    if (messages.length > lastCountRef.current) {
      const newest = messages[messages.length - 1]
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160
      if (nearBottom || newest?.sender_id === meId) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
    lastCountRef.current = messages.length
  }, [threadId, messages, meId])

  // A late-loading photo grows the page after the first jump — keep pinned to the bottom for the first moments.
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const t = setTimeout(() => {
      if (openedRef.current === threadId && el.scrollHeight - el.scrollTop - el.clientHeight < 400) el.scrollTop = el.scrollHeight
    }, 600)
    return () => clearTimeout(t)
  }, [threadId, messages.length])

  const groups = groupByDay(messages)
  const byId = new Map(messages.map(m => [m.id, m]))

  return (
    <div ref={boxRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain bg-zinc-100 px-3 py-3" data-testid="talk-messages">
      {loading && messages.length === 0 ? (
        <p className="py-10 text-center text-sm text-zinc-400">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="py-10 text-center text-sm text-zinc-400">No messages yet. Say hello.</p>
      ) : (
        <div className="space-y-2.5">
          {groups.map(g => (
            <div key={g.key} className="space-y-1.5">
              <div className="sticky top-0 z-[1] flex justify-center py-1">
                <span className="rounded-full bg-white/90 px-3 py-0.5 text-xs font-medium text-zinc-500 shadow-sm">{g.label}</span>
              </div>
              {g.messages.map(m => (
                <Bubble key={m.id} m={m} mine={m.sender_id === meId} seen={m.sender_id === meId && isSeen(m)} showSender={showSender} meId={meId} byId={byId}
                  highlighted={highlightId === m.id} onMenu={onMenu} onReply={onReply} onReact={onReact} onJumpTo={onJumpTo} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
