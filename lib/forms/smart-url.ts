import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { APP_BASE_URL, PORTAL_BASE_URL } from "@/lib/config"

/**
 * Returns the best URL to send a token+code form to a contact.
 *
 * If the contact has a portal user, returns the portal-internal URL so they
 * stay logged in inside the portal layout. Otherwise returns the public URL.
 *
 * @param contactId — the recipient who will fill the form
 * @param token, accessCode — form identifiers
 * @param publicPath — path on app.tonydurante.us (e.g. "contact-request")
 *                    Used as fallback when no portal user exists.
 */
export async function buildFormUrl({
  contactId,
  token,
  accessCode,
  publicPath,
}: {
  contactId: string
  token: string
  accessCode: string
  publicPath: string
}): Promise<string> {
  // Look up contact email; portal users are keyed by email
  const { data: contact } = await supabaseAdmin
    .from("contacts")
    .select("email")
    .eq("id", contactId)
    .maybeSingle()

  if (contact?.email) {
    const authUser = await findAuthUserByEmail(contact.email)
    if (authUser) {
      // Portal user exists → send the in-portal viewer URL
      return `${PORTAL_BASE_URL}/portal/form/${token}/${accessCode}`
    }
  }

  // Fallback: public URL on app.tonydurante.us
  return `${APP_BASE_URL}/${publicPath}/${token}/${accessCode}`
}
