import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { checkMetaConnection } from "@/lib/marketing/meta-leads/connection"
import { configuredPageIds, fetchTokenIdentity, listPageForms, listPageSubscribedApps } from "@/lib/marketing/meta-leads/graph"

export const dynamic = "force-dynamic"
const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/marketing-admin/meta/check — Antonio's "is Meta connected?" button (TD Marketing, dev job 9aec66fa). Admin only (the strict
 * check). Reads from Meta with the server's own Page access key; nothing is changed. Secrets are reported as set / not set, never their value.
 */
export async function POST() {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  const report = await checkMetaConnection({
    env: {
      appSecret: !!process.env.META_APP_SECRET,
      verifyToken: !!process.env.META_WEBHOOK_VERIFY_TOKEN,
      pageToken: !!process.env.META_PAGE_ACCESS_TOKEN,
      pageIds: configuredPageIds(),
      appId: /^\d{5,30}$/.test(process.env.META_APP_ID ?? "") ? (process.env.META_APP_ID as string) : null,
    },
    identity: () => fetchTokenIdentity(),
    subscribedApps: id => listPageSubscribedApps(id),
    forms: id => listPageForms(id),
  })
  return NextResponse.json(report, { headers: NO_STORE })
}
