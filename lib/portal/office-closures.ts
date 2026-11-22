/**
 * Planned office closures (a holiday week, a trip) — ONE list that drives three things at once, so they cannot disagree:
 *   1. the portal's Open/Closed clock (components/portal/office-clock.tsx) turns red "closed" and names the reopen day;
 *   2. the notice drawn right under that clock, with no close button, on every portal page;
 *   3. the chat out-of-office reply (lib/portal/auto-reply.ts), in the client's language.
 *
 * Why code and not a database row (Antonio, 22 Nov 2026, after a five-reviewer pass): an operational fact ("the office is closed") must not
 * be controlled by a row in the CRM's announcements screen, where one click switches a row off or deletes it and the clock would silently say
 * "Open" on a closed day; that screen also writes the same words into both languages, so any edit would overwrite the Italian. A closure
 * a few times a year does not justify a database column. To add one: append an entry below (tests guard the shape), then release.
 *
 * Dates are plain New York calendar days ("YYYY-MM-DD"), compared as text. `closedUntil` is INCLUDED. The window should run through the
 * weekend that follows, so the clock never flips to "open" on a Saturday morning. `reopens` is the first working day back; a test checks
 * that the normal rule really has the office open that day.
 */

export type ClosureLocale = 'en' | 'it'

export interface OfficeClosureCopy {
  /** Heads-up notice shown from `noticeFrom` until the day before `closedFrom`. */
  noticeTitle: string
  noticeMessage: string
  /** Notice shown while the office is closed (`closedFrom` … `closedUntil`). */
  closedTitle: string
  closedMessage: string
  /** Replaces the clock's "open Monday to Friday…" line while the office is closed. */
  clockSub: string
  /** The whole chat out-of-office reply while closed (replaces the normal reply). */
  autoReply: string
}

export interface OfficeClosure {
  id: string
  /** First day the heads-up notice is shown. */
  noticeFrom: string
  /** First closed day. */
  closedFrom: string
  /** Last closed day (included). */
  closedUntil: string
  /** First working day back. */
  reopens: string
  copy: Record<ClosureLocale, OfficeClosureCopy>
}

export const OFFICE_CLOSURES: readonly OfficeClosure[] = [
  {
    id: 'thanksgiving-2026',
    noticeFrom: '2026-11-23',
    closedFrom: '2026-11-25',
    closedUntil: '2026-11-29',
    reopens: '2026-11-30',
    copy: {
      en: {
        noticeTitle: 'Reminder: office closed from Wednesday, November 25',
        noticeMessage: 'Our office will be closed for the Thanksgiving holiday from Wednesday, November 25. We reopen on Monday, November 30.',
        closedTitle: 'Office closed for Thanksgiving from Wednesday, November 25',
        closedMessage: 'We reopen on Monday, November 30. You can still use your portal to check documents and invoices. Happy Thanksgiving from all of us at Tony Durante LLC.',
        clockSub: 'Closed for Thanksgiving. We reopen on Monday, November 30.',
        autoReply: 'We are currently closed. Office closed for Thanksgiving from Wednesday, November 25. We reopen on Monday, November 30. You can still use your portal to check documents and invoices. Happy Thanksgiving from all of us at Tony Durante LLC.',
      },
      it: {
        noticeTitle: 'Promemoria: ufficio chiuso da mercoledì 25 novembre',
        noticeMessage: 'Il nostro ufficio sarà chiuso per la festa del Ringraziamento da mercoledì 25 novembre. Riapriamo lunedì 30 novembre.',
        closedTitle: 'Ufficio chiuso per il Ringraziamento da mercoledì 25 novembre',
        closedMessage: 'Riapriamo lunedì 30 novembre. Puoi comunque usare il portale per consultare documenti e fatture. Buon Thanksgiving da tutto il team di Tony Durante LLC.',
        clockSub: 'Chiusi per il Ringraziamento. Riapriamo lunedì 30 novembre.',
        autoReply: 'Siamo attualmente chiusi. Ufficio chiuso per il Ringraziamento da mercoledì 25 novembre. Riapriamo lunedì 30 novembre. Puoi comunque usare il portale per consultare documenti e fatture. Buon Thanksgiving da tutto il team di Tony Durante LLC.',
      },
    },
  },
]

export type ClosurePhase = 'notice' | 'closed'

export interface ActiveClosure {
  closure: OfficeClosure
  phase: ClosurePhase
}

/** Which phase one closure is in on a New York day ("YYYY-MM-DD"): the heads-up, the closure itself, or neither. */
export function closurePhaseOn(dateKey: string, closure: OfficeClosure): ClosurePhase | null {
  if (dateKey >= closure.closedFrom && dateKey <= closure.closedUntil) return 'closed'
  if (dateKey >= closure.noticeFrom && dateKey < closure.closedFrom) return 'notice'
  return null
}

/** The closure (if any) that is in its heads-up or closed phase on this New York day. A closed one wins over a heads-up for another. */
export function activeClosureOn(dateKey: string, closures: readonly OfficeClosure[] = OFFICE_CLOSURES): ActiveClosure | null {
  let notice: ActiveClosure | null = null
  for (const closure of closures) {
    const phase = closurePhaseOn(dateKey, closure)
    if (phase === 'closed') return { closure, phase }
    if (phase === 'notice' && !notice) notice = { closure, phase }
  }
  return notice
}

/** The words for a portal language: Italian for 'it', English for everything else (a language we have no words for reads English). */
export function closureCopy(closure: OfficeClosure, locale: string | null | undefined): OfficeClosureCopy {
  return locale === 'it' ? closure.copy.it : closure.copy.en
}
