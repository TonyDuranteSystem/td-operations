import { NextRequest } from "next/server"
import { newsAdminGate, json, isUuid } from "@/lib/marketing/news-route"
import { validateNews } from "@/lib/marketing/news"
import { editNews, withdrawNews } from "@/lib/marketing/news-server"

export const dynamic = "force-dynamic"

/** PATCH /api/marketing-admin/news/[id] — change a posted news item (it is shown as edited). Admin only. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await newsAdminGate(req)
  if (g.res) return g.res
  const { id } = await params
  if (!isUuid(id)) return json({ error: "News not found." }, 404)
  const v = validateNews(g.body)
  if (v.ok === false) return json({ error: v.error }, 400)
  const r = await editNews(id, v.value)
  if (r.ok === false) return json({ error: r.error }, r.status)
  return json({ ok: true })
}

/** DELETE /api/marketing-admin/news/[id] — withdraw a news item: the team stops seeing it; Antonio keeps it and who read it. Admin only. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await newsAdminGate(req, false)
  if (g.res) return g.res
  const { id } = await params
  if (!isUuid(id)) return json({ error: "News not found." }, 404)
  const r = await withdrawNews(id)
  if (r.ok === false) return json({ error: r.error }, r.status)
  return json({ ok: true })
}
