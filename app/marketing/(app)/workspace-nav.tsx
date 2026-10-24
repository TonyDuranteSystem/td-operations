'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useT } from '@/components/marketing/lang-provider'
import { NAV_ORDER_KEY, moveNav, orderNav, parseSavedOrder } from '@/lib/marketing/nav-order'

interface Item { key: string; label: string; href: string; built: boolean; badge?: number }

/** The sidebar list. A screen that is not built yet is not shown at all. The person can put the entries in his own order ("Reorder"); the order is kept in his browser. */
export function WorkspaceNav({ items }: { items: Item[] }) {
  const path = usePathname() ?? ''
  const t = useT()
  const shown = items.filter(i => i.built)
  const [order, setOrder] = useState<string[]>([])
  const [editing, setEditing] = useState(false)
  useEffect(() => { try { setOrder(parseSavedOrder(window.localStorage.getItem(NAV_ORDER_KEY))) } catch { /* the order is only a convenience */ } }, [])
  const list = orderNav(shown, order)
  const move = (index: number, by: -1 | 1) => {
    const next = moveNav(list, index, by).map(i => i.key)
    setOrder(next)
    try { window.localStorage.setItem(NAV_ORDER_KEY, next.join(',')) } catch { /* the order is only a convenience */ }
  }
  return (
    <nav aria-label={t('Workspace')} className="flex flex-col gap-0.5">
      {list.map((i, idx) => {
        const on = path === i.href || path.startsWith(`${i.href}/`)
        return (
          <div key={i.key} className="flex items-center gap-1">
            <Link href={i.href} aria-current={on ? 'page' : undefined} data-testid={`nav-${i.key}`}
              className={`flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm ${on ? 'bg-teal-50 font-semibold text-teal-800' : 'text-slate-700 hover:bg-slate-100'}`}>
              <span className="truncate">{t(i.label)}</span>
              {i.badge ? <span className="rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white" data-testid={`nav-${i.key}-badge`}>{i.badge}</span> : null}
            </Link>
            {editing && (
              <span className="flex shrink-0 flex-col">
                <button type="button" aria-label={t('Move up')} data-testid={`nav-up-${i.key}`} disabled={idx === 0} onClick={() => move(idx, -1)} className="px-1 text-[10px] leading-3 text-slate-500 hover:text-slate-900 disabled:opacity-30">▲</button>
                <button type="button" aria-label={t('Move down')} data-testid={`nav-down-${i.key}`} disabled={idx === list.length - 1} onClick={() => move(idx, 1)} className="px-1 text-[10px] leading-3 text-slate-500 hover:text-slate-900 disabled:opacity-30">▼</button>
              </span>
            )}
          </div>
        )
      })}
      <button type="button" onClick={() => setEditing(e => !e)} data-testid="nav-reorder" className="mt-2 self-start rounded px-3 py-1 text-xs text-slate-500 hover:bg-slate-100">{editing ? t('Done') : t('Reorder')}</button>
    </nav>
  )
}
