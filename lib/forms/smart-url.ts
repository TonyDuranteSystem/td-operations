import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { APP_BASE_URL, PORTAL_BASE_URL } from "@/lib/config"
import { FORM_BY_TYPE } from "@/lib/forms/registry"

/**
 * Returns the best URL to send a token+code form to a contact.
 *
 * If the contact has a portal user, returns the portal-internal URL so they
 * stay logged in inside the portal layout (same-origin → in-app navigation
 * in portal chat). Otherwise returns the public URL on app.tonydurante.us.
 *
 * Falls back to the public URL if the Supabase auth API is unreachable or
 * the contact has no email — so this function never throws.
 *
 * @param contactId  — recipient who will fill the form
 * @param token      — form token
 * @param accessCode — form access code
 * @param formType   — registry key, e.g. "member_info", "contact_request"
 */
export async function buildFormUrl({
  contactId,
  token,
  accessCode,
  formType,
}: {
  contactId: string
  token: string
  accessCode: string
  formType: string
}): Promise<string> {
  const def = FORM_BY_TYPE[formType]
  const publicUrl = `${APP_BASE_URL}/${def?.publicPath ?? formType}/${token}/${accessCode}`

  try {
    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("email")
      .eq("id", contactId)
      .maybeSingle()

    if (contact?.email) {
      const authUser = await findAuthUserByEmail(contact.email)
      if (authUser) {
        return `${PORTAL_BASE_URL}/portal/form/${token}/${accessCode}`
      }
    }
  } catch {
    // Auth API unreachable or unexpected error → fall through to public URL
  }

  return publicUrl
}

/**
 * Returns the admin preview URL for a form.
 * Always the public path + ?preview=td — never the portal viewer URL,
 * because the portal viewer has no adminMode support (no amber badge,
 * no disabled submit).
 */
export function buildAdminPreviewUrl(
  formType: string,
  token: string,
  accessCode: string,
): string {
  const def = FORM_BY_TYPE[formType]
  const path = def?.publicPath ?? formType
  return `${APP_BASE_URL}/${path}/${token}/${accessCode}?preview=td`
}
