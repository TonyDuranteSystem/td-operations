/**
 * Staff "admin preview" authorization for token-gated PUBLIC routes.
 *
 * ⛔ SECURITY INCIDENT 2026-07-21 — read before changing anything here.
 *
 * Nine public routes accepted `?preview=td` (or a `preview=td` form field) as
 * PROOF OF STAFF IDENTITY and skipped the access-code check entirely:
 *
 *   app/api/ss4/[token]/pdf                  — returned the filled SS-4 PDF
 *                                              INCLUDING responsible_party_itin
 *   app/api/ss4/[token]/upload-signed        — overwrote the signed SS-4
 *                                              (storage upload uses upsert:true)
 *   app/api/8832/[token]/pdf                 — same, Form 8832
 *   app/api/8832/[token]/upload-signed       — same, overwrite
 *   app/api/signature-request/[token]/upload-signed
 *   app/api/sign/[token]/{fetch,pdf,submit,decline}
 *
 * A query string is not a credential. Combined with tokens derived from the
 * company name + year (company names are public in state business registries),
 * this was a credential-free chain from a public registry listing to a client's
 * ITIN — and, on the upload routes, to REPLACING a signed IRS form (document
 * substitution, not merely disclosure).
 *
 * The rule now: the preview FLAG only expresses intent. Staff identity must be
 * proved by a real dashboard session, exactly as every dashboard route does.
 *
 * FAILS CLOSED. No session, no cookies, an auth error, or a client-role user
 * all return false — the caller then falls back to the normal access-code
 * check, which is the correct secure behaviour. Staff who are not signed in on
 * the domain serving the form simply use the access code (visible in the CRM);
 * nothing goes down.
 *
 * NEVER reintroduce a bypass that trusts request-supplied data. If a new
 * token-gated route needs an admin preview, call this.
 */
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"

/**
 * True only when the caller holds a genuine, non-client dashboard session.
 *
 * @param flagged whether the caller ASKED for preview (query param / form
 *        field). Passing the flag alone never grants anything — it is combined
 *        with the session check so that a non-staff caller carrying a valid
 *        access code cannot also unlock preview-only behaviour (skipping
 *        consent, sequential-signing order, or view tracking).
 */
export async function isStaffPreview(flagged: boolean): Promise<boolean> {
  if (!flagged) return false
  try {
    const supabase = createClient()
    const { data, error } = await supabase.auth.getUser()
    if (error) return false
    return isDashboardUser(data?.user ?? null)
  } catch {
    // Cookies unavailable / auth unreachable → not staff. Fail closed.
    return false
  }
}
