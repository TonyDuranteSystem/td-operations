"use client"

import { useState } from "react"

/** Read-only value + copy button (e.g. a signing link). */
export function CopyField({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2">
      <input readOnly value={value} className="flex-1 rounded-md border bg-zinc-50 px-2 py-1 text-xs text-zinc-600" onFocus={e => e.target.select()} />
      <button
        onClick={() => {
          navigator.clipboard?.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        className="shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-zinc-50"
      >
        {copied ? "Copied" : label}
      </button>
    </div>
  )
}
