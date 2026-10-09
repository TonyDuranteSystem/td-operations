'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, CheckCheck, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  formatSize, groupByDay, isAudio, isImage, linkify, seenState, timeLabel,
  type TalkAttachment, type TalkMessage,
} from '@/lib/talk/chat-model'

/** One attachment inside a bubble: a voice note you can play, a photo you can open, or a file you can download. */
function Attachment({ a }: { a: TalkAttachment }) {
  const [broken, setBroken] = useState(false)
  if (isAudio(a) && !broken) {
    return (
      <audio
        controls
        preload="metadata"
        src={a.url}
        className="h-10 w-60 max-w-full"
        onError={() => setBroken(true)}
        data-testid="talk-voice-note"
      />
    )
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

function Bubble({ m, mine, peerReadAt }: { m: TalkMessage; mine: boolean; peerReadAt: string | null }) {
  const atts = (m.attachments ?? []).filter(a => a && a.url)
  const deleted = !!m.deleted_at
  const seen = mine && seenState(m, peerReadAt) === 'seen'
  return (
    <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        data-testid={mine ? 'talk-msg-mine' : 'talk-msg-theirs'}
        className={cn(
          'max-w-[82%] rounded-2xl px-3 py-2 shadow-sm',
          mine ? 'rounded-br-md bg-[#fbe3e5] text-zinc-900' : 'rounded-bl-md border border-zinc-200 bg-white text-zinc-900',
        )}
      >
        {deleted ? (
          <p className="text-sm italic text-zinc-400">This message was deleted</p>
        ) : (
          <div className="space-y-1.5">
            {atts.map((a, i) => <Attachment key={`${a.url}-${i}`} a={a} />)}
            {m.message ? <Text text={m.message} /> : null}
          </div>
        )}
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-zinc-500">
          <span>{timeLabel(m.created_at)}</span>
          {mine && !deleted && (
            seen
              ? <CheckCheck className="h-3.5 w-3.5 text-sky-600" aria-label="Seen" data-testid="talk-tick-seen" />
              : <Check className="h-3.5 w-3.5 text-zinc-400" aria-label="Sent" data-testid="talk-tick-sent" />
          )}
        </div>
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
  threadId, messages, meId, peerReadAt, loading,
}: { threadId: string; messages: TalkMessage[]; meId: string; peerReadAt: string | null; loading: boolean }) {
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

  return (
    <div ref={boxRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain bg-zinc-100 px-3 py-3" data-testid="talk-messages">
      {loading && messages.length === 0 ? (
        <p className="py-10 text-center text-sm text-zinc-400">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="py-10 text-center text-sm text-zinc-400">No messages yet. Say hello.</p>
      ) : (
        <div className="space-y-1.5">
          {groups.map(g => (
            <div key={g.key} className="space-y-1.5">
              <div className="sticky top-0 z-[1] flex justify-center py-1">
                <span className="rounded-full bg-white/90 px-3 py-0.5 text-xs font-medium text-zinc-500 shadow-sm">{g.label}</span>
              </div>
              {g.messages.map(m => <Bubble key={m.id} m={m} mine={m.sender_id === meId} peerReadAt={peerReadAt} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
