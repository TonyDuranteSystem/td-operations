/**
 * Portal SS-4 Signing Page — Embeds the external SS-4 page inside the portal.
 *
 * Same pattern as OA and Lease portal pages:
 * 1. Gets the logged-in user's contact ID and selected account
 * 2. Finds the SS-4 application linked to that account
 * 3. Embeds the external SS-4 page in an iframe with auto-verification
 */

export const dynamic = "force-dynamic"

import { createClient } from "@/lib/supabase/server"
import { getClientContactId } from "@/lib/portal-auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { getPortalAccounts } from "@/lib/portal/queries"
import { APP_BASE_URL } from "@/lib/config"
import { PortalSS4Client } from "./portal-ss4-client"
import { cookies } from "next/headers"

export default async function PortalSignSS4Page() {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-zinc-500">Please log in to view your documents.</p>
      </div>
    )
  }

  const contactId = getClientContactId(user)
  if (!contactId) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-zinc-500">No contact associated with your account.</p>
      </div>
    )
  }

  // Get selected account
  const accounts = await getPortalAccounts(contactId)
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get("portal_account_id")?.value
  const selectedAccountId = accounts.length > 0 ? (accounts.find((a) => a.id === cookieAccountId)?.id ?? accounts[0].id) : ""

  if (!selectedAccountId) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-2">
          <p className="text-zinc-500 text-lg">No company found.</p>
          <p className="text-zinc-400 text-sm">Your SS-4 will appear here once your company is set up.</p>
        </div>
      </div>
    )
  }

  // Find the SS-4 for this account (most recent)
  const { data: ss4 } = await supabaseAdmin
    .from("ss4_applications")
    .select("token, access_code, status, company_name, language")
    .eq("account_id", selectedAccountId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!ss4) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-2">
          <p className="text-zinc-500 text-lg">No SS-4 application found.</p>
          <p className="text-zinc-400 text-sm">Your EIN application will appear here once it has been generated.</p>
        </div>
      </div>
    )
  }

  // Construct URL with portal=true
  const ss4Url = `${APP_BASE_URL}/ss4/${ss4.token}/${ss4.access_code}?portal=true`

  return <PortalSS4Client ss4Url={ss4Url} status={ss4.status} companyName={ss4.company_name} language={ss4.language} />
}
