'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Archive, ArchiveRestore, Bot, ClipboardList, Cog, Forward, Link2, Mail, MailOpen, MoreHorizontal, Printer, Receipt, Reply, Send, Star, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AppMoreAction, AppPrimaryAction, AppThreadPlan } from '@/lib/inbox/app-thread-actions'

/**
 * The short toolbar of an open email / chat inside the TD Social phone app (dev job 2072bc3e, Step 1b).
 * Every button is at least 44 px (Apple's minimum). It only DRAWS the plan from lib/inbox/app-thread-actions.ts;
 * what each button does is handed in by the Inbox shell (the same handlers the computer layout uses).
 */
export type AppThreadHandlers = Partial<Record<AppPrimaryAction | AppMoreAction, () => void>>

const MORE: Record<AppMoreAction, { label: string; icon: ReactNode }> = {
  task: { label: 'Create task', icon: <ClipboardList className="h-4 w-4" /> },
  service: { label: 'Create service', icon: <Cog className="h-4 w-4" /> },
  invoice: { label: 'Create invoice', icon: <Receipt className="h-4 w-4" /> },
  worker: { label: 'Worker (AI)', icon: <Bot className="h-4 w-4" /> },
  share: { label: 'Share to team chat', icon: <Send className="h-4 w-4" /> },
  forward: { label: 'Forward', icon: <Forward className="h-4 w-4" /> },
  star: { label: 'Pin', icon: <Star className="h-4 w-4" /> },
  link: { label: 'Link to client / lead / partner', icon: <Link2 className="h-4 w-4" /> },
  print: { label: 'Print / save as PDF', icon: <Printer className="h-4 w-4" /> },
  copyLink: { label: 'Copy a link to this chat', icon: <Link2 className="h-4 w-4" /> },
}

const iconBtn = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-zinc-600 hover:bg-zinc-100 disabled:opacity-50'

export function AppThreadActions({ plan, unread, starred, busy, handlers, compact = false }: {
  plan: AppThreadPlan
  /** the open email is currently unread (the read/unread button shows the opposite action) */
  unread: boolean
  starred: boolean
  busy: boolean
  handlers: AppThreadHandlers
  /** only the "…" menu, at the right end of the title row (a WhatsApp chat: Reply would just scroll to the message box that is already on screen) */
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  // Escape closes the "…" menu (a phone with a keyboard attached, or a screen reader's escape gesture)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return (
    // its own full-width row under the title (the approved mockup's action row): Reply, Archive, Unread, Delete share the width
    <div className={compact ? 'ml-auto flex items-center' : 'flex w-full basis-full items-stretch gap-1'} data-testid="app-thread-actions">
      {!compact && plan.primary.map(key => {
        const run = handlers[key]
        if (!run) return null
        if (key === 'reply') {
          return (
            <button key={key} type="button" onClick={run} className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-blue-50 px-3 text-sm font-semibold text-blue-700 hover:bg-blue-100">
              <Reply className="h-4 w-4" /> Reply
            </button>
          )
        }
        const spec = {
          archive: { label: 'Archive', short: 'Archive', icon: <Archive className="h-5 w-5" />, cls: '' },
          toggleRead: { label: unread ? 'Mark as read' : 'Mark as unread', short: unread ? 'Read' : 'Unread', icon: unread ? <MailOpen className="h-5 w-5" /> : <Mail className="h-5 w-5" />, cls: '' },
          delete: { label: 'Delete (moves to Trash)', short: 'Delete', icon: <Trash2 className="h-5 w-5" />, cls: 'text-red-600' },
          restore: { label: 'Restore to Inbox', short: 'Restore', icon: <ArchiveRestore className="h-5 w-5" />, cls: 'text-green-700' },
        }[key]
        return (
          <button key={key} type="button" onClick={run} disabled={busy} aria-label={spec.label} className={cn('flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50', spec.cls)}>
            {spec.icon}
            <span>{spec.short}</span>
          </button>
        )
      })}
      {plan.more.length > 0 && (
        <div className="relative">
          <button type="button" onClick={() => setOpen(o => !o)} aria-label="More actions" aria-expanded={open} className={iconBtn}>
            <MoreHorizontal className="h-5 w-5" />
          </button>
          {open && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
              <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-zinc-200 bg-white py-1 shadow-xl">
                {plan.more.map(key => {
                  const run = handlers[key]
                  if (!run) return null
                  const label = key === 'star' && starred ? 'Unpin' : MORE[key].label
                  return (
                    <button key={key} type="button" disabled={busy && key !== 'worker'} onClick={() => { setOpen(false); run() }}
                      className="flex min-h-[44px] w-full items-center gap-3 px-4 text-left text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">
                      {MORE[key].icon}
                      {label}
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
