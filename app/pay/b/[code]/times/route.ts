/**
 * Booking page, PAID links — the free times for the person's page: GET /pay/b/<code>/times (public; the 128-bit code is the key). Read only: it asks Calendly which times of the
 * paid call type are free and returns them as UTC texts. Plain JSON, never cached, never framed, no referrer. Calendly's own error text is never passed on.
 */
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { calendlyCtxFromEnv } from "@/lib/calendly/api"
import { BOOK_STATUS, loadSlots } from "@/lib/booking/book-and-pay"

export const dynamic = "force-dynamic"

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY" } as const

export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const r = await loadSlots({ db: supabaseAdmin, calendly: calendlyCtxFromEnv() }, code)
  if ("reason" in r) return NextResponse.json({ ok: false, reason: r.reason, message: r.message }, { status: BOOK_STATUS[r.reason], headers: HEADERS })
  return NextResponse.json({ ok: true, slots: r.slots, minutes: r.minutes }, { status: 200, headers: HEADERS })
}
