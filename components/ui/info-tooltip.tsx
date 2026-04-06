'use client'

import { Info } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'

interface InfoTooltipProps {
  text: string
  className?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
}

export function InfoTooltip({ text, className, side = 'bottom' }: InfoTooltipProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const positions: Record<string, string> = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  }

  return (
    <div ref={ref} className={cn('relative inline-flex', className)}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="p-0.5 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors focus:outline-none focus:ring-1 focus:ring-zinc-300"
        aria-label="Info"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          className={cn(
            'absolute z-50 w-56 px-3 py-2 text-xs text-zinc-700 bg-white rounded-lg shadow-lg border border-zinc-200 leading-relaxed',
            positions[side]
          )}
        >
          {text}
        </div>
      )}
    </div>
  )
}
