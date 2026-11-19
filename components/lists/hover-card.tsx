'use client'

import { FastTooltip } from '@/components/ui/fast-tooltip'
import { cn } from '@/lib/utils'
import type { CardModel } from '@/lib/crm-lists/hover-cards'

/** How long the pointer rests on a name before its card opens: long enough that sweeping across the list shows nothing. */
const HOVER_DELAY_MS = 350
/** A card runs about ten lines at most (title, subtitle, up to six lines of details, a heading and companies). */
const CARD_HEIGHT = 260
/** An amber block adds its heading plus about three lines for each finding. */
const ALERT_BASE_HEIGHT = 40
const ALERT_BLOCK_HEIGHT = 64

/** The contents of a hover card: a title, a small grey line, label/value details and (for a person) a short list of companies. */
export function HoverCardBody({ card }: { card: CardModel }) {
  return (
    <div className="space-y-1.5">
      <div>
        <p className="font-semibold leading-snug">{card.title}</p>
        {card.subtitle && <p className="text-zinc-400">{card.subtitle}</p>}
      </div>
      {card.alert && (
        <div className="space-y-1 rounded border border-amber-400/50 bg-amber-500/15 p-1.5" data-testid="card-alert">
          <p className="font-semibold text-amber-300">{card.alert.heading}</p>
          {card.alert.blocks.map((b, i) => (
            <div key={`${b.title}-${i}`}>
              <p className="font-medium break-words">{b.title}</p>
              {b.lines.map((line) => (
                <p key={line} className="break-words text-zinc-200">{line}</p>
              ))}
            </div>
          ))}
        </div>
      )}
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
 * screen shows no card (FastTooltip gates on a real hover pointer). `card` null draws no card at all. The card is interactive (Antonio
 * 2026-11-15): the pointer can move onto it and its text can be selected and copied; it closes a moment after the pointer leaves both.
 */
export function ListHoverCard({ card, children, className }: { card: CardModel | null; children: React.ReactNode; className?: string }) {
  if (!card) return <>{children}</>
  const height = CARD_HEIGHT + (card.alert ? ALERT_BASE_HEIGHT + card.alert.blocks.length * ALERT_BLOCK_HEIGHT : 0)
  return (
    <FastTooltip label={undefined} card={<HoverCardBody card={card} />} align="left" delayMs={HOVER_DELAY_MS} cardHeightPx={height} interactive className={className}>
      {children}
    </FastTooltip>
  )
}
