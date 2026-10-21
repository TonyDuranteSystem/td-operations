'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

interface Item { key: string; label: string; href: string; built: boolean }

/** The sidebar list. A screen that is not built yet is greyed with "soon", never a link that goes nowhere. */
export function WorkspaceNav({ items }: { items: Item[] }) {
  const path = usePathname() ?? ''
  return (
    <nav aria-label="Workspace" className="flex flex-col gap-0.5">
      {items.map(i => i.built ? (
        <Link key={i.key} href={i.href} aria-current={path === i.href || path.startsWith(`${i.href}/`) ? 'page' : undefined}
          className={`rounded-lg px-3 py-2 text-sm ${path === i.href || path.startsWith(`${i.href}/`) ? 'bg-teal-50 font-semibold text-teal-800' : 'text-slate-700 hover:bg-slate-100'}`}>{i.label}</Link>
      ) : (
        <span key={i.key} className="cursor-default rounded-lg px-3 py-2 text-sm text-slate-400" title="Not built yet">{i.label} <span className="text-[10px] uppercase">soon</span></span>
      ))}
    </nav>
  )
}
