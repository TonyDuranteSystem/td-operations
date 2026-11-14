/**
 * Booking page — the two Calendly call types the maker uses, read from app_settings.booking_templates (set by SQL, never hard-coded):
 *   plain  the personal Zoom call with no sales questions
 *   sales  the call that asks the sales questions (made for a new person who becomes a lead)
 * Each holds the Calendly event type's address (used to make a link with its own length) and its public booking page (used for the standard 30-minute link).
 * PURE. A template that is missing or not a plain calendly.com address is "not set up": the maker refuses with a plain sentence instead of guessing.
 */

import { eventTypeUuidOf } from "@/lib/calendly/api"
import { isPlainCalendlyUrl } from "@/lib/booking-links/destination"
import type { TemplateRole } from "@/lib/booking/plan"

export interface BookingTemplate {
  eventTypeUri: string
  schedulingUrl: string
}
export type BookingTemplates = Partial<Record<TemplateRole, BookingTemplate>>

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

function one(raw: unknown): BookingTemplate | null {
  if (!isRec(raw)) return null
  const uri = typeof raw.event_type_uri === "string" ? raw.event_type_uri.trim() : ""
  const url = typeof raw.scheduling_url === "string" ? raw.scheduling_url.trim() : ""
  if (!eventTypeUuidOf(uri) || !isPlainCalendlyUrl(url)) return null
  return { eventTypeUri: uri, schedulingUrl: url }
}

export function parseBookingTemplates(raw: unknown): BookingTemplates {
  if (!isRec(raw)) return {}
  const out: BookingTemplates = {}
  const sales = one(raw.sales)
  const plain = one(raw.plain)
  if (sales) out.sales = sales
  if (plain) out.plain = plain
  return out
}

export const TEMPLATES_MISSING_TEXT = "The Calendly call types for this page are not set up yet. Ask Claude to set them."

export function templateFor(templates: BookingTemplates, role: TemplateRole): BookingTemplate | null {
  return templates[role] ?? null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic service client
type Db = any

/** Reads the setting. Missing, unreadable or malformed = nothing set up (never throws). */
export async function loadTemplates(db: Db): Promise<BookingTemplates> {
  try {
    const { data, error } = await db.from("app_settings").select("value").eq("key", "booking_templates").maybeSingle()
    return error || !data ? {} : parseBookingTemplates(data.value)
  } catch {
    return {}
  }
}
