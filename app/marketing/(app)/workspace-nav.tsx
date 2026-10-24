'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useT } from '@/components/marketing/lang-provider'

interface Item { key: string; label: string; href: string; built: boolean }

/** The sidebar list. A screen that is not built yet is not shown at all (a greyed "soon" row only made people wonder what was missing). */
export function WorkspaceNav({ items }: { items: Item[] }) {
  const path = usePathname() ?? ''
  const t = useT()
  return (
    <nav aria-label={t('Workspace')} className="flex flex-col gap-0.5">
      {items.filter(i => i.built).map(i => (
        <Link key={i.key} href={i.href} aria-current={path === i.href || path.startsWith(`${i.href}/`) ? 'page' : undefined}
          className={`rounded-lg px-3 py-2 text-sm ${path === i.href || path.startsWith(`${i.href}/`) ? 'bg-teal-50 font-semibold text-teal-800' : 'text-slate-700 hover:bg-slate-100'}`}>{t(i.label)}</Link>
      ))}
    </nav>
  )
}
