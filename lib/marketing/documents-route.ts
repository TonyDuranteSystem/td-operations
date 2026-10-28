import { NextRequest, NextResponse } from "next/server"
import { requireMarketing, type MarketingContext } from "@/lib/marketing/guard"
import { canManageDocuments, canReadDocuments } from "@/lib/marketing/documents-rules"
import { DocsError } from "@/lib/marketing/documents-server"
import { isSameOriginJson } from "@/lib/storage-app/request-checks"

const NO_STORE = { "Cache-Control": "no-store" }

/** The signed-in marketing person, with the right to read (or, for a change, to manage) the documents; or the ready-made refusal. Changes also need a same-origin JSON request. */
export async function docsGate(req: NextRequest, need: "read" | "manage"): Promise<{ ctx: MarketingContext; res?: undefined } | { ctx?: undefined; res: NextResponse }> {
  const g = await requireMarketing()
  if (g.res) return { res: g.res }
  const ok = need === "manage" ? canManageDocuments(g.ctx.permissions) : canReadDocuments(g.ctx.permissions)
  if (!ok) return { res: NextResponse.json({ error: "You are not allowed to do this." }, { status: 403, headers: NO_STORE }) }
  if (need === "manage" && !isSameOriginJson(req.headers, req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host)) return { res: NextResponse.json({ error: "This request did not come from the Documents page." }, { status: 403, headers: NO_STORE }) }
  return { ctx: g.ctx }
}

/** Every failure becomes one plain sentence with the right status; nothing technical reaches the screen. */
export function docsError(e: unknown, fallback: string): NextResponse {
  if (e instanceof DocsError) return NextResponse.json({ error: e.message }, { status: e.status, headers: NO_STORE })
  console.error("[marketing documents]", e instanceof Error ? e.message : e)
  return NextResponse.json({ error: fallback }, { status: 500, headers: NO_STORE })
}

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })
export const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
