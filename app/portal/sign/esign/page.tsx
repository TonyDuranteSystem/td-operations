/**
 * Portal e-sign signing page — embeds the generic e-sign signer page inside the
 * portal for a logged-in client. Token via query: /portal/sign/esign?token=...
 *
 * Security: the signer row must belong to the logged-in client (email match),
 * so one client can't open another's signing link through the portal.
 */

export const dynamic = "force-dynamic"

import { createClient } from "@/lib/supabase/server"
import { getClientContactId } from "@/lib/portal-auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { originFromHeaders } from "@/lib/esign/link-base"
import { PortalDocumentClient } from "../document/portal-document-client"
import { headers } from "next/headers"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

function Message({ text }: { text: string }) {
  return (
    <div className="flex h-[60vh] items-center justify-center">
      <p className="text-zinc-500">{text}</p>
    </div>
  )
}

export default async function PortalEsignSignPage({ searchParams }: { searchParams: { token?: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return <Message text="Please log in to view your documents." />

  const contactId = getClientContactId(user)
  if (!contactId) return <Message text="No contact associated with your account." />

  const token = (await searchParams)?.token
  if (!token) return <Message text="No document specified." />

  const { data: signer } = await db
    .from("esign_signers")
    .select("token, access_code, email, status, envelope_id, contact_id")
    .eq("token", token)
    .maybeSingle()
  // The signer must be the logged-in client — by linked CRM contact (robust) or
  // by the email TD entered (covers signers added before contact linking).
  const ownedByContact = !!signer?.contact_id && signer.contact_id === contactId
  const ownedByEmail = (signer?.email || "").toLowerCase() === (user.email || "").toLowerCase() && !!user.email
  if (!signer || (!ownedByContact && !ownedByEmail)) {
    return <Message text="Document not found, or it isn't associated with your account." />
  }

  const { data: env } = await db.from("esign_envelopes").select("document_name, status").eq("id", signer.envelope_id).maybeSingle()

  const h = await headers()
  const origin = originFromHeaders(n => h.get(n)) || ""
  const docUrl = `${origin}/sign/${signer.token}/${signer.access_code}?portal=true`
  const status = signer.status === "signed" ? "signed" : "awaiting_signature"

  return <PortalDocumentClient docUrl={docUrl} status={status} documentName={env?.document_name || "Document"} />
}
