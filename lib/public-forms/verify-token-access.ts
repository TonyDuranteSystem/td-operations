/**
 * Shared server-side gate for the public token+code "signing link" pages
 * (SS-4, ITIN, and the rest of the public form family).
 *
 * These pages used to query Supabase directly from the browser with the anon
 * key, trusting a client-supplied `.eq("token", token)` filter to scope the
 * result. That filter is not enforced by the database — the underlying RLS
 * policies allow the table's SELECT/UPDATE unconditionally for anon, so a
 * request that skips the filter (or targets the table directly via the
 * REST API) returns every row. This helper does the token+code check
 * server-side with the service role, so the anon grant can be revoked.
 *
 * Reuses lib/esign/access-guard.ts's accessCodeError rather than a bare
 * `!==` compare — that file exists specifically because a bare comparison
 * on this SAME code family (8-hex-char / 32-bit codes) fails closed
 * incorrectly: when a row's access_code is null/blank and no code is
 * supplied, `null !== null` is true-as-in-JS-equal, silently granting
 * access. It also adds a constant-time compare and a per-(IP, token)
 * lockout — SS-4/ITIN codes were historically exempt from that hardening
 * only because the anon-grant hole made the code check moot; this fix
 * removes that hole, making the code the only real gate, so it needs the
 * same hardening the OA/e-sign family already has.
 *
 * NOT a drop-in fit for every future form on this same treatment: `offers`
 * treats a MISSING access_code as "no gate, always accessible" (see
 * app/offer/[token]/page.tsx), the opposite of this helper's fail-closed-on-
 * blank-code semantics. Decide that table's own no-code behavior explicitly
 * before wiring it to this helper — don't assume the semantics transfer.
 */

import type { NextRequest } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStaffPreview } from "@/lib/auth/staff-preview"
import { accessCodeError } from "@/lib/esign/access-guard"

/**
 * Deliberately a FLAT shape, not a discriminated union on an `ok` flag: this
 * repo compiles with `strict: false`, where narrowing a union by a boolean
 * literal discriminant does not work and every field access after the guard
 * fails to typecheck (see lib/storage/upload-guard.ts, same convention).
 * Callers branch on `error` being non-null. `row` is only meaningful, and
 * never includes `access_code`, when `error` is null.
 */
export interface TokenAccessResult<T> {
  error: string | null
  status: 403 | 404 | 429 | null
  row: T | null
  isAdmin: boolean
}

function denied<T>(status: 403 | 404 | 429, error: string): TokenAccessResult<T> {
  return { error, status, row: null, isAdmin: false }
}

/**
 * Look up a row by `token`, then require EITHER a real staff session
 * (preview=td flag + isStaffPreview) OR a matching `access_code` (rate
 * limited, constant-time, fails closed on a blank code on either side).
 * The returned row NEVER includes `access_code` — the caller already has
 * it (it's in the URL); echoing it back in a JSON response would hand the
 * credential to anyone who can see the response, defeating the point of
 * checking it server-side.
 */
export async function verifyTokenAccess<T extends { access_code: string | null }>(
  req: NextRequest,
  table: string,
  select: string,
  token: string,
  code: string | null,
  previewRequested: boolean,
): Promise<TokenAccessResult<Omit<T, "access_code">>> {
  // Cast the Supabase builder to break contextual type inference here: a
  // variable table name plus this function's own generic T combine to blow
  // past TypeScript's instantiation-depth limit against Supabase's already
  // deeply-generic query builder. The row is validated/typed via T (the
  // caller's own interface) immediately below instead.
  const { data, error } = (await (supabaseAdmin as any)
    .from(table)
    .select(select)
    .eq("token", token)
    .maybeSingle()) as { data: unknown; error: { message: string } | null }

  if (error || !data) {
    return denied(404, "Not found")
  }

  const row = data as unknown as T
  const isAdmin = await isStaffPreview(previewRequested)

  const codeErr = accessCodeError(req, {
    token,
    expected: row.access_code ?? "",
    provided: code ?? "",
    isPreview: isAdmin,
  })
  if (codeErr) {
    return denied(codeErr.status as 403 | 404 | 429, codeErr.error)
  }

  const { access_code: _accessCode, ...rest } = row
  return { error: null, status: null, row: rest as Omit<T, "access_code">, isAdmin }
}
