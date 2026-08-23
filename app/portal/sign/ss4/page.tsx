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
import { t, getLocale } from "@/lib/portal/i18n"
import { loadTranslationsForLocale } from "@/lib/portal/translations-store"
import { interpolateString } from "@/lib/template-interpolation"

export default async function PortalSignSS4Page() {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-zinc-500">{t("signDocs.notLoggedIn")}</p>
      </div>
    )
  }

  const locale = getLocale(user)
  const translations = await loadTranslationsForLocale(locale)

  const contactId = getClientContactId(user)
  if (!contactId) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-zinc-500">{t("signDocs.noContact", locale, translations)}</p>
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
          <p className="text-zinc-500 text-lg">{t("signDocs.noCompany", locale, translations)}</p>
          <p className="text-zinc-400 text-sm">{t("signSubpages.ss4.noCompanyDesc", locale, translations)}</p>
        </div>
      </div>
    )
  }

  // Find the SS-4 for this account (most recent)
  const { data: ss4 } = await supabaseAdmin
    .from("ss4_applications")
    .select("token, access_code, status, company_name, contact_id, responsible_party_name")
    .eq("account_id", selectedAccountId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!ss4) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-2">
          <p className="text-zinc-500 text-lg">{t("signSubpages.ss4.notFoundTitle", locale, translations)}</p>
          <p className="text-zinc-400 text-sm">{t("signSubpages.ss4.notFoundDesc", locale, translations)}</p>
        </div>
      </div>
    )
  }

  // Only the designated responsible party can sign. contact_id=null means legacy SS-4
  // created before this field was added — show to everyone for backwards compatibility.
  if (ss4.contact_id && ss4.contact_id !== contactId) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-2">
          <p className="text-zinc-500 text-lg">{interpolateString(t("signSubpages.ss4.wrongSignerTitle", locale, translations), { name: ss4.responsible_party_name })}</p>
          <p className="text-zinc-400 text-sm">{t("signSubpages.ss4.wrongSignerDesc", locale, translations)}</p>
        </div>
      </div>
    )
  }

  // Construct URL with portal=true
  const ss4Url = `${APP_BASE_URL}/ss4/${ss4.token}/${ss4.access_code}?portal=true`

  return <PortalSS4Client ss4Url={ss4Url} status={ss4.status} companyName={ss4.company_name} />
}
