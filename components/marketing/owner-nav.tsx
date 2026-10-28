'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { OWNER_MENU, activeOwnerItem } from '@/lib/marketing/owner-menu'

/**
 * Antonio's Marketing menu (TD Marketing, dev job 9aec66fa, Addendum H): the same list in his CRM section and around the team's screens, so he never "goes into Rocco's dashboard" to reach a screen.
 * English (his own screens). A red number sits on What's New (drafts waiting for his OK) and on Messages (unread chats).
 */
export function OwnerNav({ badges }: { badges: Partial<Record<'news' | 'messages', number>> }) {
  const path = usePathname() ?? ''
  const on = activeOwnerItem(path)
  const link = (key: string, label: string, href: string, active: boolean, badge?: number, child = false) => (
    <Link key={key} href={href} aria-current={active ? 'page' : undefined} data-testid={`owner-nav-${key}`}
      className={`flex items-center justify-between gap-2 rounded-lg py-2 text-sm ${child ? 'pl-7 pr-3' : 'px-3'} ${active ? 'bg-teal-50 font-semibold text-teal-800' : 'text-slate-700 hover:bg-slate-100'}`}>
      <span className="truncate">{label}</span>
      {badge ? <span className="rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white" data-testid={`owner-nav-${key}-badge`}>{badge}</span> : null}
    </Link>
  )
  const row = (it: (typeof OWNER_MENU)[number]) => (
    <div key={it.key} className="flex flex-col gap-0.5">
      {link(it.key, it.label, it.href, on.item === it.key && on.child === null, badges[it.key as 'news' | 'messages'])}
      {on.item === it.key && it.children?.map(c => link(c.key, c.label, c.href, on.child === c.key, undefined, true))}
    </div>
  )
  return (
    <nav aria-label="Marketing" className="flex flex-col gap-0.5" data-testid="owner-nav">
      {OWNER_MENU.filter(i => !i.admin).map(row)}
      <p className="mt-3 px-3 text-[10px] uppercase tracking-wide text-slate-400">Admin</p>
      {OWNER_MENU.filter(i => i.admin).map(row)}
    </nav>
  )
}
