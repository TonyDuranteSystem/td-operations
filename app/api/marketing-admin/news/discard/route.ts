import { NextRequest } from "next/server"
import { newsAdminGate, json } from "@/lib/marketing/news-route"
import { discardDraft } from "@/lib/marketing/news-server"

export const dynamic = "force-dynamic"

/** POST /api/marketing-admin/news/discard — body { featureKey }. Antonio decided a prepared draft is not for the team; it never comes back. Admin only. */
export async function POST(req: NextRequest) {
  const g = await newsAdminGate(req)
  if (g.res) return g.res
  const key = (g.body as { featureKey?: unknown } | null)?.featureKey
  if (typeof key !== "string" || !key) return json({ error: "That draft does not exist." }, 404)
  const r = await discardDraft(g.by, key)
  if (r.ok === false) return json({ error: r.error }, r.status)
  return json({ ok: true })
}
