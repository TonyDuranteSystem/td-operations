/**
 * Portal Generic Document Signing Page
 *
 * Embeds the external signing page inside the portal.
 * Token is passed via query param: /portal/sign/document?token=sig-xxx
 */

export const dynamic = "force-dynamic"

import { createClient } from "@/lib/supabase/server"
import { getClientContactId } from "@/lib/portal-auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { getPortalAccounts } from "@/lib/portal/queries"
import { APP_BASE_URL } from "@/lib/config"
import { PortalDocumentClient } from "./portal-document-client"
import { cookies } from "next/headers"

export default async function PortalSignDocumentPage({
  searchParams,
}: {
  searchParams: { token?: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

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

  const resolvedParams = await searchParams
  const token = resolvedParams?.token

  if (!token) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-zinc-500">No document specified.</p>
      </div>
    )
  }

  const accounts = await getPortalAccounts(contactId)
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get("portal_account_id")?.value
  const selectedAccountId = accounts.length > 0 ? (accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0].id) : ""

  // Find the signature request
  const { data: sigReq } = await supabaseAdmin
    .from("signature_requests")
    .select("token, access_code, status, document_name")
    .eq("token", token)
    .eq("account_id", selectedAccountId)
    .maybeSingle()

  if (!sigReq) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-2">
          <p className="text-zinc-500 text-lg">Document not found.</p>
          <p className="text-zinc-400 text-sm">The document may have been removed or is not associated with your account.</p>
        </div>
      </div>
    )
  }

  const docUrl = `${APP_BASE_URL}/sign-document/${sigReq.token}/${sigReq.access_code}?portal=true`

  return <PortalDocumentClient docUrl={docUrl} status={sigReq.status} documentName={sigReq.document_name} />
}
