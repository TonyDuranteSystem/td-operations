/**
 * The guard for the three cookie routes that publish an app version (/api/store-devices/app-release/*). Publishing decides what software runs on
 * the team's Macs, so it is the strictest door in the Mac-app system: our own page only (same origin, JSON), a staff login, the OWNER only
 * (not even other admins), and — like approving a Mac — a fresh real two-step check this session.
 */
import { NextRequest, NextResponse } from "next/server"
import type { User } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"
import { denyUnlessStoreStaff } from "@/app/api/crm-store/browse/_auth"
import { isSameOriginJson, needsFreshSecondStep } from "./request-checks"

export async function requirePublisher(req: NextRequest): Promise<{ user: User } | NextResponse> {
  if (!isSameOriginJson(req.headers, req.nextUrl.host)) return NextResponse.json({ error: "Not allowed." }, { status: 403 })
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 })
  if (!isOwnerOnly(user)) return NextResponse.json({ error: "Only the owner can publish the TD Storage app." }, { status: 403 })
  const hasVerifiedFactor = (user.factors ?? []).some((f) => f.factor_type === "totp" && f.status === "verified")
  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (needsFreshSecondStep({ hasVerifiedFactor, aal: aalData?.currentLevel })) {
    return NextResponse.json({ error: "Please sign in to the CRM again and enter your two-step code, then publish." }, { status: 403 })
  }
  return { user }
}
