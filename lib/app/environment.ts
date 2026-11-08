/**
 * TD Social — which server is this, and which app (bundle id) belongs to it (pure; dev job 2072bc3e, Step 2 pull request A).
 *
 * The answer comes from the REAL database address the server is connected to (the project reference inside the Supabase URL), not from
 * an optional setting that may be missing. Anything not recognised is "unknown" and the callers do nothing: a local stack, a typo or a new
 * project can never be mistaken for production. The production reference is the one the Drive guard already uses (one copy of that fact).
 *
 * Two apps exist: the production build and the sandbox build. A server accepts ONLY its own bundle id, so a sandbox build can never
 * register itself on production and the other way round (checked at registration, and again at send time in the sender, Step 2 pull request C2).
 */
import { PRODUCTION_SUPABASE_REF } from "@/lib/google-drive-guard"

export const SANDBOX_SUPABASE_REF = "xjcxlmlpeywtwkhstjlw"

export type AppServerEnv = "production" | "sandbox" | "unknown"

export const TD_SOCIAL_BUNDLE_IDS: Readonly<Record<"production" | "sandbox", string>> = {
  production: "com.tonydurante.tdsocial",
  sandbox: "com.tonydurante.tdsocial.sandbox",
}

/** The project reference inside `https://<ref>.supabase.co`, else null (a local stack, a custom host, garbage). */
export function supabaseRefFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.protocol !== "https:") return null
    const m = /^([a-z0-9]{20})\.supabase\.co$/.exec(u.hostname)
    return m ? m[1] : null
  } catch {
    return null
  }
}

export function appServerEnv(supabaseUrl: string | null | undefined): AppServerEnv {
  const ref = supabaseRefFromUrl(supabaseUrl)
  if (ref === PRODUCTION_SUPABASE_REF) return "production"
  if (ref === SANDBOX_SUPABASE_REF) return "sandbox"
  return "unknown"
}

/**
 * The CLIENT iPhone app (MyLLC Manager 2.0, dev job 056a70d0). It ships as the next version of the existing App Store record
 * "MyLLC Manager", so the production id is that record's own. The sandbox id has no App Store record (simulator / cable only), the
 * same arrangement as TD Social's sandbox flavour. A server accepts only its own id: a sandbox build can never register on production.
 */
export const CLIENT_APP_BUNDLE_IDS: Readonly<Record<"production" | "sandbox", string>> = {
  production: "com.tonydurante.myllcmanager",
  sandbox: "com.tonydurante.myllcmanager.sandbox",
}

/** The one client-app bundle id this server accepts, or null when the server cannot tell what it is. */
export function allowedClientBundleId(env: AppServerEnv): string | null {
  return env === "unknown" ? null : CLIENT_APP_BUNDLE_IDS[env]
}

/** The one bundle id this server accepts, or null when the server cannot tell what it is. */
export function allowedBundleId(env: AppServerEnv): string | null {
  return env === "unknown" ? null : TD_SOCIAL_BUNDLE_IDS[env]
}

/** The environment of THIS running server. */
export function currentAppServerEnv(): AppServerEnv {
  return appServerEnv(process.env.NEXT_PUBLIC_SUPABASE_URL)
}
