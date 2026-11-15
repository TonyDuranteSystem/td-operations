/**
 * Booking page — what the booker is asked (dev job a9285887, Antonio 15 Nov 2026: "see/edit/modify the questions for the booker").
 *
 * The questions live in CALENDLY, on the call type (the "plain" and "sales" ones named in app_settings.booking_templates), not in our system. This page SHOWS them, read from
 * Calendly each time. It does not edit them: the connection the app has to Calendly has no way to change questions (the update call has no field for them), and an edit on a call
 * type would change every link and the public booking page that use it, not just one link. Editing stays in Calendly (the page links to the call types there; Calendly does not
 * give a direct link to one call type's editor).
 *
 * What the page DOES control, per link, is which of the two call types the link uses (see decideLinkPlan's `questions`).
 * Reads only; never throws; a call type Calendly could not be asked about says so instead of showing a guess.
 */

import { getEventType, type CalendlyCtx, type CalendlyQuestion } from "@/lib/calendly/api"
import { loadTemplates } from "@/lib/booking/templates"
import type { TemplateRole } from "@/lib/booking/plan"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic service client
type Db = any

/** Calendly's own page for the call types (its editor opens from here; there is no direct link to one call type's editor). */
export const CALENDLY_CALL_TYPES_URL = "https://calendly.com/app/scheduling/meeting_types/user/me"

export type CallQuestions = { ok: true; callName: string | null; questions: CalendlyQuestion[] } | { ok: false; error: string }
export type AllQuestions = Record<TemplateRole, CallQuestions>

const NOT_SET_UP = "This call type is not set up yet."
const NOT_READ = "The questions could not be read from Calendly just now."

export async function loadCallQuestions(db: Db, calendly: CalendlyCtx): Promise<AllQuestions> {
  const templates = await loadTemplates(db)
  const one = async (role: TemplateRole): Promise<CallQuestions> => {
    const tpl = templates[role]
    if (!tpl) return { ok: false, error: NOT_SET_UP }
    try {
      const t = await getEventType(calendly, tpl.eventTypeUri)
      return { ok: true, callName: t.name, questions: t.questions }
    } catch {
      return { ok: false, error: NOT_READ }
    }
  }
  const [plain, sales] = await Promise.all([one("plain"), one("sales")])
  return { plain, sales }
}
