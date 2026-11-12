'use client'

// Client iPhone app, Overview redesign (dev job 056a70d0): the company's four addresses as four cards.
// Same four addresses, same wording, every account shows all four and never hides one (dev job 254834cc, 17 Sep 2026: the descriptions stay
// full-length). New here: a coloured picture tile, the lines set in a soft box, and a Copy button that copies the address the way it is
// written on an envelope. The website's single "Your Addresses" box is unchanged.
import { useEffect, useRef, useState } from 'react'
import { Copy, FileText, Mail, Package, ShieldCheck, type LucideIcon } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'
import { copyText } from '@/lib/portal-app/clipboard'
import type { AddressRow } from '@/lib/portal-app/overview-format'

export type AppAddressIcon = 'shield' | 'file' | 'mail' | 'box'
export type AppAddressTone = 'green' | 'amber' | 'blue' | 'rose'

export interface AppAddressItem {
  key: string
  icon: AppAddressIcon
  tone: AppAddressTone
  label: string
  description: string
  rows: AddressRow[]
  legacy: string | null
  copyText: string | null
  emptyText: string
}

const ICONS: Record<AppAddressIcon, LucideIcon> = { shield: ShieldCheck, file: FileText, mail: Mail, box: Package }
const TILES: Record<AppAddressTone, string> = {
  green: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-700',
  blue: 'bg-blue-50 text-blue-700',
  rose: 'bg-rose-50 text-rose-700',
}

function AddressCard({ item }: { item: AppAddressItem }) {
  const { t } = useLocale()
  const Icon = ICONS[item.icon]
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const copy = async () => {
    if (!item.copyText) return
    if (await copyText(item.copyText)) {
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <section data-testid={`app-address-${item.key}`} className="space-y-2.5 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${TILES[item.tone]}`}><Icon className="h-5 w-5" aria-hidden="true" /></div>
        <h3 className="text-base font-semibold text-zinc-900">{item.label}</h3>
      </div>
      <p className="text-sm leading-snug text-zinc-600">{item.description}</p>
      <div className="rounded-xl bg-zinc-50 px-3 py-1.5 text-sm">
        {item.rows.length > 0 ? (
          item.rows.map((row, i) => (
            <div key={row.key} className={`flex justify-between gap-3 py-1.5 ${i > 0 ? 'border-t border-zinc-200/70' : ''}`}>
              <span className="shrink-0 text-zinc-500">{row.label}</span>
              <span className="break-words text-right font-medium text-zinc-900">{row.value}</span>
            </div>
          ))
        ) : item.legacy ? (
          <p className="break-words py-1.5 text-zinc-900">{item.legacy}</p>
        ) : (
          <p className="py-1.5 text-zinc-400">{item.emptyText}</p>
        )}
      </div>
      {item.copyText && (
        <button
          type="button"
          onClick={copy}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-blue-50 text-sm font-semibold text-blue-600"
        >
          <Copy className="h-4 w-4" aria-hidden="true" />
          {copied ? t('app.overview.copied') : t('app.overview.copyAddress')}
        </button>
      )}
    </section>
  )
}

export function AppAddressCards({ title, items }: { title: string; items: AppAddressItem[] }) {
  return (
    <div data-testid="app-address-cards" className="space-y-3">
      <p className="px-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</p>
      {items.map(item => <AddressCard key={item.key} item={item} />)}
    </div>
  )
}
