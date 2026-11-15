'use client'

import { FastTooltip } from '@/components/ui/fast-tooltip'
import { cn } from '@/lib/utils'
import type { CardModel } from '@/lib/crm-lists/hover-cards'

/** How long the pointer rests on a name before its card opens: long enough that sweeping across the list shows nothing. */
const HOVER_DELAY_MS = 350
/** A card runs about ten lines at most (title, subtitle, up to six lines of details, a heading and companies). */
const CARD_HEIGHT = 260

/** The contents of a hover card: a title, a small grey line, label/value details and (for a person) a short list of companies. */
export function HoverCardBody({ card }: { card: CardModel }) {
  return (
    <div className="space-y-1.5">
      <div>
        <p className="font-semibold leading-snug">{card.title}</p>
        {card.subtitle && <p className="text-zinc-400">{card.subtitle}</p>}
      </div>
      {card.lines.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          {card.lines.map(l => (
            <div key={l.label} className="contents">
              <dt className="text-zinc-400">{l.label}</dt>
              <dd className={cn('break-words', l.tone === 'bad' && 'font-semibold text-red-300')}>{l.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {card.items && (
        <div>
          <p className="text-zinc-400">{card.items.heading}</p>
          <ul className="space-y-0.5">
            {card.items.entries.map(e => (
              <li key={e} className="break-words">{e}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * Wraps a name so that resting the mouse on it opens a small card with the record's details (Antonio 2026-11-14). Reads only what the
 * list already loaded, so nothing is fetched on hover. A mouse-only convenience: clicking the name still opens the record, and a touch
 * screen shows no card (FastTooltip gates on a real hover pointer). `card` null draws no card at all.
 */
export function ListHoverCard({ card, children, className }: { card: CardModel | null; children: React.ReactNode; className?: string }) {
  if (!card) return <>{children}</>
  return (
    <FastTooltip label={undefined} card={<HoverCardBody card={card} />} align="left" delayMs={HOVER_DELAY_MS} cardHeightPx={CARD_HEIGHT} className={className}>
      {children}
    </FastTooltip>
  )
}
