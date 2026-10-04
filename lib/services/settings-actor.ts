/**
 * Who changed a service setting (N1a P2).
 *
 * Every change to a service card (catalog_entries, catalog_id='services') or a service step (pipeline_stages) is
 * recorded by the database itself into service_settings_history (migration 20261004-0100). The trigger reads the
 * author from this request header, so the app stamps each such write with `.setHeader(SETTINGS_ACTOR_HEADER, …)`.
 * A write without the header is still recorded — as "db:<role>" — so a missed caller shows up instead of vanishing.
 * The author is never stored on the row: a later change can't be credited to the last editor.
 */
export const SETTINGS_ACTOR_HEADER = "x-td-actor"

/** A short, header-safe author label: the staff email, or a system label like "mcp:execute_sql". */
export function settingsActor(label: string | null | undefined, fallback = "app:unknown"): string {
  // Headers are ASCII-only and single-line; keep it short and printable so a bad value can't fail the request.
  const clean = (label ?? "").replace(/[^\x20-\x7E]/g, "").trim().slice(0, 200)
  return clean || fallback
}
