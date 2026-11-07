'use client'

import { MessageSquareWarning } from 'lucide-react'

/**
 * What our team wrote next to ONE of the client's answers when they asked for changes (tax questionnaire review, dev job 7df278cd).
 * Shown under the field it is about. The text is exactly what staff wrote; only the small heading is translated.
 */
export function ReviewNote({ note, heading }: { note: string; heading: string }) {
  return (
    <div role="note" data-testid="wizard-review-note" className="mt-2 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
      <MessageSquareWarning className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <span>
        <span className="font-semibold">{heading}:</span> {note}
      </span>
    </div>
  )
}

/** The ring around a flagged field's box, so the answer to fix is easy to spot among the others. */
export const FLAGGED_FIELD_CLASS = 'rounded-lg ring-2 ring-amber-300 ring-offset-2 p-1'
