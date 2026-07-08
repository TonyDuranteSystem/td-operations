'use client'

/**
 * HoverHint — a small legend that appears UNDER the wrapped control while the
 * pointer rests on it (Antonio 2026-07-08: "the small legend under each
 * button when we pass with the pointer to know what it is about").
 * Pure CSS (group-hover) — no state, no portals.
 */

import type { ReactNode } from 'react'

export function HoverHint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="relative inline-flex group/hint">
      {children}
      <span
        className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1.5 z-50
          whitespace-nowrap rounded-md bg-zinc-800 px-2 py-1 text-[11px] font-medium text-white shadow-lg
          opacity-0 group-hover/hint:opacity-100 transition-opacity duration-150 delay-150"
      >
        {label}
      </span>
    </span>
  )
}
