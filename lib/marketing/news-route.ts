/**
 * TD Marketing — shared door for the What's New routes (server; dev job 9aec66fa, Addendum H). Antonio's routes (post, edit, withdraw, approve, discard) accept ONLY the strict admin check and a JSON request.
 * Every answer is "no-store". The team's own route (mark read) goes through `requireMarketing` like every other marketing route.
 */
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"

export const NO_STORE = { "Cache-Control": "no-store" }
export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })
export const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

/** The signed-in strict admin (his email is who posted), or the ready-to-return refusal. */
export async function newsAdminGate(req: NextRequest, needBody = true): Promise<{ by: string; body: unknown; res?: undefined } | { res: NextResponse; by?: undefined; body?: undefined }> {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return { res: json({ error: "Not allowed." }, 403) }
  if (!needBody) return { by: user.email ?? user.id, body: null }
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return { res: json({ error: "Send JSON." }, 415) }
  return { by: user.email ?? user.id, body: await req.json().catch(() => null) }
}
