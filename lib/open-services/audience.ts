/**
 * Open services tab — server side of the guard (N1a C3).
 *
 * `requireOpenServicesAccess()` is the ONLY door to the data: the page calls it first and the loader will not run
 * without the access object it returns. It re-reads the setting on EVERY request (supabaseAdmin is no-store; the
 * page is dynamic), never throws, and any failure means "not allowed".
 */

import { cache } from "react"
import type { User } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { parseAudience, type Audience } from "@/lib/open-services/audience-shared"
import { canViewOpenServices } from "@/lib/open-services/access"

/**
 * The stored audience; 'off' on a missing row, a bad value, or a failed read. Read directly (not through
 * getAppSetting, which swallows database errors) so a real read failure is LOGGED instead of looking like a plain
 * "not found" — it still fails closed.
 */
export async function getOpenServicesAudience(): Promise<Audience> {
  try {
    const { data, error } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", "open_services_audience")
      .maybeSingle()
    if (error) throw new Error(error.message)
    return parseAudience(data?.value ?? "off")
  } catch (err) {
    console.error("[open-services] could not read open_services_audience — treating as off:", err)
    return "off"
  }
}

declare const grantedBrand: unique symbol
/** Proof that the guard passed. Only `requireOpenServicesAccess` can make one. */
export interface OpenServicesAccessGranted {
  ok: true
  user: User
  audience: Audience
  readonly [grantedBrand]: true
}
export type OpenServicesAccess = OpenServicesAccessGranted | { ok: false }

async function resolveAccess(): Promise<OpenServicesAccess> {
  try {
    const audience = await getOpenServicesAudience()
    if (audience === "off") return { ok: false }
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || !canViewOpenServices(user, audience)) return { ok: false }
    return { ok: true, user, audience } as OpenServicesAccessGranted
  } catch (err) {
    console.error("[open-services] access check failed — denying:", err)
    return { ok: false }
  }
}

/** Cached per request, so the page and anything it calls share one resolution. */
export const requireOpenServicesAccess = cache(resolveAccess)
