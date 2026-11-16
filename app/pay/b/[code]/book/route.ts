/**
 * Booking page, PAID links — "Book and pay", the booking half: POST /pay/b/<code>/book (public; the 128-bit code is the key). Body (JSON): { start, name, email, timezone }.
 * Books the picked time through Calendly (lib/booking/book-and-pay.ts) and marks the link booked; the page then sends the person to the card page. Plain JSON, never cached,
 * never framed, no referrer. Only a request from our own page is accepted (an Origin header, when present, must be this site), and the body is small.
 */
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { calendlyCtxFromEnv } from "@/lib/calendly/api"
import { BOOK_SAYS, BOOK_STATUS, bookSlot, type BookNo } from "@/lib/booking/book-and-pay"

export const dynamic = "force-dynamic"

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY" } as const
const MAX_BODY = 4096

const refuse = (reason: BookNo, message?: string): NextResponse => NextResponse.json({ ok: false, reason, message: message ?? BOOK_SAYS[reason] }, { status: BOOK_STATUS[reason], headers: HEADERS })

/** A request from another site (a form posted from a stranger's page) is refused: the Origin, when the browser sends one, must be the host this page is served from. */
function sameSite(req: NextRequest): boolean {
  const origin = req.headers.get("origin")
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.get("host")
  } catch {
    return false
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  if (!sameSite(req)) return NextResponse.json({ ok: false, reason: "invalid", message: BOOK_SAYS.invalid }, { status: 403, headers: HEADERS })
  const { code } = await params
  let body: unknown = null
  try {
    const text = await req.text()
    if (text.length > MAX_BODY) return refuse("invalid")
    body = JSON.parse(text)
  } catch {
    return refuse("invalid")
  }
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  if (!b) return refuse("invalid")
  const r = await bookSlot({ db: supabaseAdmin, calendly: calendlyCtxFromEnv() }, code, { start: b.start, name: b.name, email: b.email, timezone: b.timezone })
  if ("reason" in r) return refuse(r.reason, r.message)
  return NextResponse.json({ ok: true, start: r.start }, { status: 200, headers: HEADERS })
}
