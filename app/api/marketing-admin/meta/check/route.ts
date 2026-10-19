import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { checkMetaConnection } from "@/lib/marketing/meta-leads/connection"
import { configuredPageIds, fetchTokenIdentity, listPageForms, listPageSubscribedApps } from "@/lib/marketing/meta-leads/graph"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { listConnections } from "@/lib/marketing/meta-leads/key-store"
import { formatWhen } from "@/lib/marketing/lead-view"

export const dynamic = "force-dynamic"
const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/marketing-admin/meta/check — Antonio's "is Meta connected?" button (TD Marketing, dev job 9aec66fa). Admin only (the strict
 * check). Reads from Meta with the server's own Page access key; nothing is changed. Secrets are reported as set / not set, never their value.
 */
export async function POST() {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  const pageIds = configuredPageIds()
  const stored = (await listConnections(leadDb(), process.env.META_APP_SECRET)).filter(c => pageIds.length === 0 || pageIds.includes(c.pageId))
  const usable = stored.find(c => c.readable)
  const envKey = !!process.env.META_PAGE_ACCESS_TOKEN
  const report = await checkMetaConnection({
    env: {
      appSecret: !!process.env.META_APP_SECRET,
      verifyToken: !!process.env.META_WEBHOOK_VERIFY_TOKEN,
      pageToken: !!usable || envKey,
      keyFrom: usable
        ? { kind: "database", note: `${usable.pageName ?? usable.pageId}, connected ${formatWhen(usable.obtainedAt)}, ${usable.longLived ? "long-lasting" : "not extended: may stop working within hours"}` }
        : stored.length ? { kind: "unreadable" } : envKey ? { kind: "vercel" } : { kind: "none" },
      pageIds,
      appId: /^\d{5,30}$/.test(process.env.META_APP_ID ?? "") ? (process.env.META_APP_ID as string) : null,
    },
    identity: () => fetchTokenIdentity(undefined, pageIds[0] ?? null),
    subscribedApps: id => listPageSubscribedApps(id),
    forms: id => listPageForms(id),
  })
  return NextResponse.json(report, { headers: NO_STORE })
}
