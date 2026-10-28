import { NextRequest } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { markNewsRead } from "@/lib/marketing/news-server"
import { json, isUuid } from "@/lib/marketing/news-route"

export const dynamic = "force-dynamic"

/** POST /api/marketing/news/[id]/read — the person opened this news item. The team and the audience come from the guard, never from the request. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireMarketing()
  if (g.res) return g.res
  const { id } = await params
  if (!isUuid(id)) return json({ error: "News not found." }, 404)
  const r = await markNewsRead(g.ctx, id)
  if (r.ok === false) return json({ error: r.error }, r.status)
  return json({ ok: true })
}
