/**
 * Server-side reader/writer for the `app_settings` table (key/jsonb/updated_at).
 *
 * Used for feature flags and other runtime-toggleable values that ops wants
 * to change without a code deploy. First real consumer: `tax_season_paused`
 * for the 2026 tax season suspension — when true, the client-facing tax
 * data-collection banner and wizard are gated off, and new Tax Return SDs
 * are auto-parked at `on_hold` at intake time instead of `active`.
 *
 * Keep this file server-only (it uses supabaseAdmin). Do not import it
 * into a client component.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

/** Known keys. Adding a new flag? Document it here, default behavior, and
 *  where it's consumed. */
export type AppSettingKey =
  | "tax_season_paused" // boolean — when true, Tax Return banner + wizard + intake are gated.
  | "renewal_banner_min_year" // number — minimum agreement_year for the portal renewal-MSA banner to show. Default 2027 (hides 2026 in purgatory). Bump higher to hide future years too.
  | "auto_activate_confidence_threshold" // 'exact' (default) | 'exact_or_high' — which match confidence levels trigger auto-activation. Anything below threshold goes to the bank-feed review queue.
  | "portal_admin_email_on_client_message" // boolean — when true (default), a client portal chat message emails support@tonydurante.us. Set false to silence those emails (push notifications are unaffected). Toggled in Dev Tools → Maintenance.
  | "new_document_alert_enabled" // boolean — when true (default), making a document client-visible alerts the client (in-portal notification + push; digest email for non-push users) and shows it as "New" until opened. Global kill switch for the new-document alert feature; consumed in lib/portal/document-alerts.ts.
  | "new_document_chat_message_enabled" // boolean — when true (default, Antonio 2026-06-11), the new-document alert ALSO posts a portal chat message ("A new document has been added to your folder: <name>", localized EN/IT). Unified across all share paths (toggle, process-and-share, uploads, signature webhook); consumed in lib/portal/document-alerts.ts. Set false for notification-only alerts.
  | "portal_digest_type_labels" // object — per-notification-type display overrides for the digest email, merged over code defaults in lib/portal/digest-render.ts. Shape: { "<type>": { icon?: string, label_en?: string, label_it?: string, show_body?: boolean } }. Lets ops rename sections / toggle item detail lines without a deploy.
  | "td_communication_settings" // object — TD Communication admin panel system settings. Shape: { enabled: boolean (portal tab visibility), disclaimer_en/it: string, default_sla_days: number }. Read/written via lib/td-communication/comm-settings.ts; edited in the CRM TD Communication → Settings tab.
  | "td_communication_landing" // object — TD Communication landing page content (Phase 9). Shape: TdCommLandingState { draft, published: LandingContent, published_at/by, updated_at/by }. Two snapshots (draft/published); Publish promotes draft→published. Read/written via lib/td-communication/landing.ts; edited in the CRM TD Communication → Landing Page tab AND /collab.
  | "slack_mirror_enabled" // boolean — when true, the Team Workspace mirrors Slack channels the bot is in (webhook ingest + conversations.history backfill) into slack_channels/slack_messages and shows a read-only "Slack" section with Open-in-Slack links. Default FALSE (dormant). Consumed in lib/team/slack-mirror.ts + the workspace UI. Toggle when ready to run Slack alongside the CRM.
  | "support_person_user_id" // string (auth user UUID) — the staff member whose DM receives "Send to Support" shares from Inbox + Portal Chats. Stores the ACTUAL user id (no name-resolution at runtime — brittle). Seeded to Luca. Read via getSupportPersonUserId(); consumed in app/api/team/share. If unset, the share endpoint returns a "no support person configured" error rather than guessing.
  | "worker_model" // string (a model id from WORKER_MODEL_OPTIONS in lib/ai-agent/worker-models.ts) — the model the WORKER runs on, shared by EVERY worker surface (Portal Chats tab, Inbox panel, dashboard sidebar, Slack, team chat). Antonio 2026-07-18: one setting, changeable from the gear on any worker panel, so the same question can't get different answers per screen. Read via resolveWorkerModelAsync() (stored → env WORKER_MODEL → built-in default), validated against the curated list so a typo'd/retired id can't take the worker down everywhere at once. Written by app/api/ai-agent/model (admin-only).

export async function getAppSetting<T = unknown>(
  key: AppSettingKey,
  fallback: T,
): Promise<T> {
  const { data, error } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle()
  if (error || !data) return fallback
  return (data.value as unknown as T) ?? fallback
}

export async function setAppSetting(
  key: AppSettingKey,
  value: unknown,
): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- app_settings is not a protected table; direct upsert is appropriate
  const { error } = await supabaseAdmin
    .from("app_settings")
    .upsert({ key, value: value as never, updated_at: new Date().toISOString() }, { onConflict: "key" })
  if (error) throw new Error(`setAppSetting(${key}) failed: ${error.message}`)
}

/** Narrow helper for the tax-season flag. Returns false (season open) by
 *  default if the row is missing or the cast fails. */
export async function isTaxSeasonPaused(): Promise<boolean> {
  const v = await getAppSetting<boolean>("tax_season_paused", false)
  return v === true
}

/** Whether a client's portal chat message should email support@tonydurante.us.
 *  Defaults to true (emails on) so behavior is unchanged until ops opts out.
 *  Push notifications to admin devices are independent of this flag. */
export async function isPortalAdminEmailEnabled(): Promise<boolean> {
  const v = await getAppSetting<boolean>("portal_admin_email_on_client_message", true)
  return v !== false
}

/** Whether the Team Workspace Slack mirror is on. Default false (dormant) so it
 *  ships without touching Slack until ops flips it on. Gates both the webhook
 *  ingest and the workspace "Slack" section. */
export async function isSlackMirrorEnabled(): Promise<boolean> {
  const v = await getAppSetting<boolean>("slack_mirror_enabled", false)
  return v === true
}

/** The staff user id whose DM receives "Send to Support" shares. Returns the
 *  stored UUID, or null when unconfigured (the share endpoint then surfaces a
 *  clear error instead of guessing a person). No runtime name-resolution — the
 *  value is a real auth user id, seeded once. */
export async function getSupportPersonUserId(): Promise<string | null> {
  const v = await getAppSetting<string | null>("support_person_user_id", null)
  const id = typeof v === "string" ? v.trim() : ""
  return id.length > 0 ? id : null
}

/** Minimum agreement_year for the portal renewal-MSA banner to render.
 *  Default 2027: hides 2026 banner during the legacy-payment purgatory year.
 *  Antonio can override via Dev Tools → "Renewal banner min year". */
export async function getRenewalBannerMinYear(): Promise<number> {
  const v = await getAppSetting<number>("renewal_banner_min_year", 2027)
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 2027
}
