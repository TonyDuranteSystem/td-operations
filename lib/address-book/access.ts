/**
 * Address book: who may open the Company book and its routes. The Company book is for the TEAM: an administrator or a team login (the two staff roles),
 * decided from app_metadata and the code's email list — never user_metadata, which the account holder can write. A client, a partner, a marketing login, an unknown role
 * and a signed-out visitor are refused. (The PERSONAL book is stricter and lives in personal-access.ts: one login only.)
 *
 * `/api/*` inherits only "is logged in" from the middleware, so the check inside each route is the real wall: it is the FIRST statement of every handler, answers 403 with no-store,
 * and refuses when the identity check itself breaks (never fails open). A route that changes anything also proves the request came from our own page.
 */
import { NextResponse } from "next/server"
import type { User } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin, isStaffUser } from "@/lib/auth"
import { isSameOriginJson } from "@/lib/storage-app/request-checks"

export function isAddressBookStaff(user: User | null | undefined): boolean {
  if (!user) return false
  return isSecureAdmin(user) || isStaffUser(user)
}

const deny = (status: number, error: string): NextResponse => NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } })

export interface Who {
  id: string | null
  email: string | null
}

/** null in `denied` = the caller is staff; otherwise the response to hand straight back. */
export async function requireStaff(): Promise<{ denied: NextResponse | null; who: Who }> {
  try {
    const { data } = await createClient().auth.getUser()
    const user = data.user ?? null
    if (!isAddressBookStaff(user)) return { denied: deny(403, "Not authorized"), who: { id: null, email: null } }
    return { denied: null, who: { id: user?.id ?? null, email: user?.email ?? null } }
  } catch {
    return { denied: deny(403, "Not authorized"), who: { id: null, email: null } }
  }
}

/** For routes that change something: the staff check first, then the same-origin JSON proof. */
export async function requireStaffJson(req: { headers: { get(name: string): string | null } }): Promise<{ denied: NextResponse | null; who: Who }> {
  const r = await requireStaff()
  if (r.denied) return r
  try {
    if (!isSameOriginJson(req.headers, req.headers.get("host") ?? "")) return { denied: deny(403, "Not allowed from here"), who: r.who }
    return r
  } catch {
    return { denied: deny(403, "Not allowed from here"), who: r.who }
  }
}

export const noStore = { "Cache-Control": "no-store" }

export function fail(status: number, error: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error, ...extra }, { status, headers: noStore })
}

export function ok(body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { headers: noStore })
}

const MAX_BODY_BYTES = 40_000

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

export const BAD_BODY = "That request was not understood. Reload the page and try again."
