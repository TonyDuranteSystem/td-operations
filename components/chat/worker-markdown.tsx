'use client'

/**
 * WorkerMarkdown — minimal, safe rendering for worker replies (the worker
 * writes light Markdown: **bold**, bullet lists, headings). Built as React
 * nodes — no dangerouslySetInnerHTML, no raw HTML pass-through.
 */

import type { ReactNode } from 'react'

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={`${keyPrefix}-${i}`} className="px-1 rounded bg-black/10 text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      )
    }
    return part
  })
}

export function WorkerMarkdown({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        const trimmed = line.trim()
        if (!trimmed) return <div key={i} className="h-1.5" />
        if (/^#{1,4}\s/.test(trimmed)) {
          return (
            <p key={i} className="font-semibold">
              {renderInline(trimmed.replace(/^#{1,4}\s/, ''), `h${i}`)}
            </p>
          )
        }
        if (/^[-•]\s/.test(trimmed)) {
          return (
            <p key={i} className="pl-3">
              <span className="mr-1.5">•</span>
              {renderInline(trimmed.replace(/^[-•]\s/, ''), `b${i}`)}
            </p>
          )
        }
        if (/^---+$/.test(trimmed)) {
          return <hr key={i} className="border-current opacity-20 my-1" />
        }
        return <p key={i}>{renderInline(line, `l${i}`)}</p>
      })}
    </div>
  )
}
