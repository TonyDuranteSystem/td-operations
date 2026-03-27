/**
 * Portal Form 8832 Signing Page — Embeds the external 8832 page inside the portal.
 *
 * Same pattern as SS-4 portal page:
 * 1. Gets the logged-in user's contact ID and selected account
 * 2. Finds the Form 8832 application linked to that account
 * 3. Embeds the external 8832 page in an iframe
 */

export const dynamic = "force-dynamic"

import { createClient } from "@/lib/supabase/server"
import { getClientContactId } from "@/lib/portal-auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { getPortalAccounts } from "@/lib/portal/queries"
import { APP_BASE_URL } from "@/lib/config"
import { Portal8832Client } from "./portal-8832-client"
import { cookies } from "next/headers"

export default async function PortalSign8832Page() {
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

  const accounts = await getPortalAccounts(contactId)
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get("portal_account_id")?.value
  const selectedAccountId = accounts.length > 0 ? (accounts.find((a) => a.id === cookieAccountId)?.id ?? accounts[0].id) : ""

  if (!selectedAccountId) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-2">
          <p className="text-zinc-500 text-lg">No company found.</p>
          <p className="text-zinc-400 text-sm">Your Form 8832 will appear here once your company is set up.</p>
        </div>
      </div>
    )
  }

  // Find the Form 8832 for this account
  const { data: form } = await supabaseAdmin
    .from("form_8832_applications")
    .select("token, access_code, status, company_name, language")
    .eq("account_id", selectedAccountId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!form) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-2">
          <p className="text-zinc-500 text-lg">No Form 8832 found.</p>
          <p className="text-zinc-400 text-sm">Your C-Corp election form will appear here once it has been generated.</p>
        </div>
      </div>
    )
  }

  const formUrl = `${APP_BASE_URL}/8832/${form.token}/${form.access_code}?portal=true`

  return <Portal8832Client formUrl={formUrl} status={form.status} companyName={form.company_name} language={form.language} />
}
