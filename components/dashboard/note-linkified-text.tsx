'use client'

/**
 * Note/reply text with pasted URLs rendered as real links (Antonio, 2026-07-29:
 * a copied message link pasted into a note must be clickable for the reader).
 * Pure text-splitting into React nodes — no HTML injection possible; http(s)
 * only. Anchors stop propagation (an ancestor card/editor block usually has
 * its own click handler — e.g. "tap the body to open the note") and carry
 * data-no-drag for any draggable ancestor (`closest('[data-no-drag]')`).
 *
 * Shared by every surface that shows note text: the full editor (author +
 * non-author views), the floating card, the mobile sheet, the Notes list,
 * and the calendar. Before 2026-09-02 only the editor's non-author view used
 * this — every compact preview (and the author's own textarea) showed a
 * pasted chat/email deep link as dead text: clicking it just opened/stayed on
 * the note instead of navigating (Antonio bug report, dev job acb315af).
 */

import { splitLinkSegments } from '@/lib/notes/note-origin'

export function LinkifiedText({ text }: { text: string }) {
  const segments = splitLinkSegments(text)
  if (segments.length === 1 && segments[0].type === 'text') return <>{text}</>
  return (
    <>
      {segments.map((s, i) =>
        s.type === 'link' ? (
          <a
            key={i}
            href={s.value}
            data-no-drag
            onClick={(e) => e.stopPropagation()}
            rel="noopener noreferrer"
            className="break-all text-blue-700 underline hover:text-blue-900"
          >
            {s.value}
          </a>
        ) : (
          <span key={i}>{s.value}</span>
        ),
      )}
    </>
  )
}
