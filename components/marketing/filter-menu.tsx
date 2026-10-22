'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'

interface Option { label: string; href: string; on: boolean }

/** A drop-down made of plain links: opening it lists the choices, picking one opens that page and closes the list. Escape or a click anywhere else closes it too, and only one is open at a time. */
export function FilterMenu({ label, current, options, testId }: { label: string; current: string; options: Option[]; testId?: string }) {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const close = (e: Event) => {
      const el = ref.current
      if (!el || !el.open) return
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !el.contains(e.target as Node)) el.open = false
    }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
  }, [])
  return (
    <details ref={ref} className="relative text-sm" data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg border bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
        <span className="text-slate-500">{label}:</span><span className="max-w-[12rem] truncate font-medium text-slate-800">{current}</span><span aria-hidden="true" className="text-slate-400">▾</span>
      </summary>
      <ul className="absolute z-20 mt-1 max-h-72 min-w-[12rem] overflow-y-auto rounded-lg border bg-white py-1 shadow-lg" aria-label={label}>
        {options.map(o => (
          <li key={`${o.label}|${o.href}`}>
            <Link href={o.href} onClick={() => { if (ref.current) ref.current.open = false }} aria-current={o.on ? 'true' : undefined} className={`block px-3 py-1.5 text-sm hover:bg-slate-50 ${o.on ? 'font-medium text-slate-900' : 'text-slate-600'}`}>{o.label}</Link>
          </li>
        ))}
      </ul>
    </details>
  )
}
