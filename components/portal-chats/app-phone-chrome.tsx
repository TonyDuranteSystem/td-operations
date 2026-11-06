'use client'

// The phone-app pieces of a Portal chat conversation (TD Social, dev job 2072bc3e; the approved mockup's "A client's chat" screen):
// ONE slim top bar, the menu behind "⋯" (what used to be the tab row and the icon cluster), the one-line "Reply to" row (what used to be
// "Send as" + "Replying in"), and the "＋" menu (emoji, attach, AI draft). Pure arrangement: every action is the SAME handler the computer
// layout uses, passed in by the page. Rendered only when the page checked `useAppMode()`.
import Link from 'next/link'
import { ChevronDown, ChevronLeft, MoreHorizontal, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { BottomSheet, SheetHeading, SheetRow } from '@/components/app-mode/bottom-sheet'

export type PhoneView = 'messages' | 'whatsnew' | 'ideas' | 'todo' | 'email' | 'worker'

export const PHONE_VIEW_LABELS: Record<PhoneView, string> = {
  messages: 'Messages',
  whatsnew: "What's New",
  ideas: 'Idea request',
  todo: 'To Do',
  email: 'Email',
  worker: 'Worker',
}

export function PhoneConvNav({ title, titleHref, subtitle, titleExtra, badge, onBack, onMore }: {
  title: string
  titleHref?: string
  subtitle?: string
  titleExtra?: ReactNode
  /** what is waiting under "⋯" (the What's New count) */
  badge: number
  onBack: () => void
  onMore: () => void
}) {
  return (
    <div className="flex h-[52px] shrink-0 items-center gap-1 border-b bg-white pl-1 pr-2" data-testid="phone-conv-nav">
      <button type="button" onClick={onBack} aria-label="Back to the list" className="flex h-11 w-9 shrink-0 items-center justify-center text-blue-600">
        <ChevronLeft className="h-7 w-7" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {titleHref ? (
            <Link href={titleHref} className="truncate text-[17px] font-semibold leading-tight text-zinc-900">{title}</Link>
          ) : (
            <p className="truncate text-[17px] font-semibold leading-tight text-zinc-900">{title}</p>
          )}
          {titleExtra}
        </div>
        {subtitle && <p className="truncate text-xs leading-tight text-zinc-500">{subtitle}</p>}
      </div>
      <button type="button" onClick={onMore} aria-label={badge > 0 ? `Conversation menu, ${badge} new` : 'Conversation menu'} className="relative flex h-11 w-11 shrink-0 items-center justify-center text-zinc-700">
        <MoreHorizontal className="h-6 w-6" />
        {badge > 0 && (
          <span className="absolute right-0.5 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white">{badge > 99 ? '99+' : badge}</span>
        )}
      </button>
    </div>
  )
}

/** When a view other than Messages is open, one line says which and leads back (the old tab row showed this by its underline). */
export function PhoneViewStrip({ view, onMessages }: { view: PhoneView; onMessages: () => void }) {
  if (view === 'messages') return null
  return (
    <button type="button" onClick={onMessages} className="flex h-10 w-full shrink-0 items-center gap-1 border-b bg-zinc-50 px-3 text-left text-sm text-blue-600">
      <ChevronLeft className="h-4 w-4" />
      <span className="font-medium">Messages</span>
      <span className="text-zinc-400">·</span>
      <span className="font-semibold text-zinc-800">{PHONE_VIEW_LABELS[view]}</span>
    </button>
  )
}

export function PhoneMoreSheet({ open, onClose, view, counts, onView, canMarkUnread, onMarkUnread, onRefresh, onCopyLink, onAi, onSelect, language }: {
  open: boolean
  onClose: () => void
  view: PhoneView
  counts: { whatsnew: number; ideas: number; email: number }
  onView: (v: PhoneView) => void
  canMarkUnread: boolean
  onMarkUnread: () => void
  onRefresh: () => void
  onCopyLink?: () => void
  onAi: () => void
  /** "Select messages to delete" (only on the Messages view) */
  onSelect?: () => void
  language?: ReactNode
}) {
  const pick = (fn: () => void) => () => { onClose(); fn() }
  const views: PhoneView[] = ['messages', 'whatsnew', 'ideas', 'todo', 'email', 'worker']
  const badgeFor = (v: PhoneView) => (v === 'whatsnew' ? counts.whatsnew : v === 'ideas' ? counts.ideas : v === 'email' ? counts.email : 0)
  return (
    <BottomSheet open={open} onClose={onClose} title="This conversation">
      {views.map(v => (
        <SheetRow key={v} label={PHONE_VIEW_LABELS[v]} badge={badgeFor(v)} checked={view === v} onClick={pick(() => onView(v))} />
      ))}
      <SheetHeading>Actions</SheetHeading>
      {canMarkUnread && <SheetRow label="Mark as unread" onClick={pick(onMarkUnread)} />}
      <SheetRow label="Refresh messages" onClick={pick(onRefresh)} />
      {onCopyLink && <SheetRow label="Copy link to this chat" onClick={pick(onCopyLink)} />}
      <SheetRow label="AI assistant" onClick={pick(onAi)} />
      {onSelect && <SheetRow label="Select messages to delete" onClick={pick(onSelect)} />}
      {language && (
        <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-5 py-2 text-base text-zinc-900">
          <span>Language</span>
          {language}
        </div>
      )}
    </BottomSheet>
  )
}

/** The one line above the message box: who the reply goes to and in which topic. It reads the SAME state the old "Send as" row and
 *  "Replying in" bar used, so what it says is what will be sent. */
export function PhoneReplyToLine({ target, topic, closed, onChange }: { target: string; topic: string; closed: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      onClick={onChange}
      aria-label={`Reply to ${target}, topic ${topic}. Tap to change.`}
      className={`app-slim-line flex h-9 w-full shrink-0 items-center justify-between gap-2 border-t px-3 text-left text-[13px] ${closed ? 'bg-red-50 text-red-700' : 'bg-zinc-50 text-zinc-500'}`}
    >
      <span className="min-w-0 flex-1 truncate">
        Reply to <span className="font-semibold text-zinc-900">{target}</span>
        <span> · {topic}</span>
        {closed && <span className="font-semibold"> · closed</span>}
      </span>
      <span className="inline-flex shrink-0 items-center gap-0.5 font-semibold text-blue-600">Change<ChevronDown className="h-3.5 w-3.5" /></span>
    </button>
  )
}

export interface PhoneCompany { id: string; name: string; closed?: boolean }

export function PhoneReplyToSheet({ open, onClose, companies, selectedCompanyId, onCompany, topics, activeTopic, onTopic, onCreateTopic }: {
  open: boolean
  onClose: () => void
  /** only for a person's thread that has companies; a company's own thread has nothing to choose */
  companies: PhoneCompany[] | null
  selectedCompanyId: string | null
  onCompany: (id: string | null) => void
  topics: { key: string; label: string; unread: number }[]
  /** '' = General */
  activeTopic: string
  onTopic: (key: string) => void
  onCreateTopic: () => void
}) {
  const pick = (fn: () => void) => () => { fn(); onClose() }
  return (
    <BottomSheet open={open} onClose={onClose} title={companies ? 'Reply to' : 'Topic'}>
      {companies && (
        <>
          {companies.map(c => (
            <SheetRow
              key={c.id}
              label={c.name}
              hint={c.closed ? 'closed company, the client cannot see it' : undefined}
              danger={!!c.closed}
              checked={selectedCompanyId === c.id}
              onClick={pick(() => onCompany(c.id))}
            />
          ))}
          <SheetRow label="Personal" hint="only this person and staff" checked={!selectedCompanyId} onClick={pick(() => onCompany(null))} />
          <SheetHeading>Topic</SheetHeading>
        </>
      )}
      {topics.map(t => (
        <SheetRow key={t.key || '__general__'} label={t.label} badge={t.unread} checked={activeTopic === t.key} onClick={pick(() => onTopic(t.key))} />
      ))}
      <SheetRow label={<span className="inline-flex items-center gap-1.5"><Plus className="h-4 w-4" />Create a topic</span>} onClick={pick(onCreateTopic)} />
    </BottomSheet>
  )
}

export function PhonePlusButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Emoji, attach a file, AI draft" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-600">
      <Plus className="h-5 w-5" />
    </button>
  )
}

export function PhonePlusSheet({ open, onClose, onEmoji, onAttach, onAi, aiBusy, attachBusy }: {
  open: boolean
  onClose: () => void
  onEmoji: () => void
  onAttach: () => void
  onAi: () => void
  aiBusy: boolean
  attachBusy: boolean
}) {
  const pick = (fn: () => void) => () => { onClose(); fn() }
  return (
    <BottomSheet open={open} onClose={onClose} title="Add to your message">
      <SheetRow label="Emoji" onClick={pick(onEmoji)} />
      <SheetRow label="Attach a file" disabled={attachBusy} onClick={pick(onAttach)} />
      <SheetRow label="AI suggest a reply" disabled={aiBusy} onClick={pick(onAi)} />
    </BottomSheet>
  )
}
