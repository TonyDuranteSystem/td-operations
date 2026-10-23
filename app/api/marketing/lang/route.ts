import { NextRequest, NextResponse } from "next/server"
import { LANG_COOKIE, parseLang } from "@/lib/marketing/lang"

/** POST /api/marketing/lang { lang: "it" | "en" } — the person's own language, in their own browser. Nothing is stored on our side; no login detail is read. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { lang?: unknown }
  const lang = parseLang(body.lang)
  const res = NextResponse.json({ ok: true, lang }, { headers: { "Cache-Control": "no-store" } })
  res.cookies.set(LANG_COOKIE, lang, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", httpOnly: false })
  return res
}
