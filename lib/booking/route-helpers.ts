/**
 * Booking page — small helpers shared by the /api/booking routes. Called only AFTER the admin gate has passed (requireAdminRoute / requireAdminJsonRoute).
 * Errors are answered as { error: "plain words" } (R099) so the page can show the real reason.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { readBookingMode } from "@/lib/booking-links/switch"
import { OFF_REFUSAL } from "@/lib/booking/mode-text"

export interface AdminWho {
  id: string | null
  email: string
}

/** Who is signed in (for "made by" / "answered by"). Only called after the gate; never throws. */
export async function currentAdmin(): Promise<AdminWho> {
  try {
    const { data } = await createClient().auth.getUser()
    return { id: data.user?.id ?? null, email: data.user?.email ?? "unknown" }
  } catch {
    return { id: null, email: "unknown" }
  }
}

const MAX_BODY_BYTES = 20_000

/** The JSON body as a plain object, or null (not JSON, not an object, or too big). */
export async function readJsonObject(req: { text(): Promise<string> }): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text()
    if (text.length > MAX_BODY_BYTES) return null
    const v = JSON.parse(text)
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export const noStore = { "Cache-Control": "no-store" }

export function fail(status: number, error: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error, ...extra }, { status, headers: noStore })
}

export function ok(body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { headers: noStore })
}

/**
 * While the Booking page is TURNED OFF (the `booking` setting is absent / malformed / "off"), every route that changes or sends anything refuses, in plain words,
 * BEFORE it reads a body or touches a table or Calendly. Called right after the admin gate by every handler that is not a plain read. An unreadable setting counts as off.
 */
export async function refuseWhileOff(): Promise<NextResponse | null> {
  const mode = await readBookingMode(supabaseAdmin)
  return mode === "off" ? fail(403, OFF_REFUSAL, { off: true }) : null
}

export const BAD_BODY = "That request was not understood. Reload the page and try again."

/** The person the maker asked for, from the JSON body. Never trusts a field's type. */
export function personRefFrom(raw: unknown): { type: "contact"; id: string } | { type: "lead"; id: string } | { type: "new"; name: string | null; email: string | null } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const p = raw as Record<string, unknown>
  if (p.type === "contact" && typeof p.id === "string") return { type: "contact", id: p.id }
  if (p.type === "lead" && typeof p.id === "string") return { type: "lead", id: p.id }
  if (p.type === "new") return { type: "new", name: typeof p.name === "string" ? p.name : null, email: typeof p.email === "string" ? p.email : null }
  return null
}
