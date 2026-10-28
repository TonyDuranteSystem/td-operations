import { NextRequest } from "next/server"
import { newsAdminGate, json } from "@/lib/marketing/news-route"
import { validateNews } from "@/lib/marketing/news"
import { postNews } from "@/lib/marketing/news-server"

export const dynamic = "force-dynamic"

/** POST /api/marketing-admin/news — body { title, body, titleIt?, bodyIt?, linkKey?, audience?, featureKey? }. Posts news to every team (featureKey = Antonio approved a prepared draft, after editing it if he wanted). Admin only. */
export async function POST(req: NextRequest) {
  const g = await newsAdminGate(req)
  if (g.res) return g.res
  const v = validateNews(g.body)
  if (v.ok === false) return json({ error: v.error }, 400)
  const featureKey = (g.body as { featureKey?: unknown } | null)?.featureKey
  const r = await postNews(g.by, v.value, typeof featureKey === "string" && featureKey ? featureKey : undefined)
  if (r.ok === false) return json({ error: r.error }, r.status)
  return json({ ok: true, id: r.data.id, notified: r.data.notified })
}
