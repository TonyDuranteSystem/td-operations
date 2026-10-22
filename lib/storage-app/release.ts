/**
 * Automatic updates of the TD Storage Mac app (dev job 1992a087): WHICH version a Mac is offered is decided here, by ONE settings row
 * (`app_settings.storage_app_release`), never by the app. The app only knows where to ask (the feed address) and which key must have signed
 * an update (both baked in at build time). Everything else is a setting read on every request, so a change needs no deploy and no new build:
 *   { "version": "0.2.0", "build": 2, "edSignature": "…", "length": 12345678, "path": "storage-app/0.2.0/TDStorage-0.2.0.zip",
 *     "notes": "…", "minSystem": "13.0", "enabled": true, "rolloutPercent": 100, "publishedAt": "2026-10-22T…Z" }
 * enabled=false is the PAUSE switch (the feed goes empty); rolloutPercent offers it to that share of Macs first (decided per Mac, stably).
 * The zip itself sits in the private bucket below; the feed hands out a short-lived signed link, and Sparkle refuses anything not signed by our key.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export const RELEASE_KEY = "storage_app_release"
export const RELEASE_BUCKET = "app-releases"
export const FEED_LINK_SECONDS = 600
export const DOWNLOAD_LINK_SECONDS = 60

export interface Release {
  version: string; build: number; edSignature: string; length: number; path: string
  notes: string; minSystem: string; enabled: boolean; rolloutPercent: number; publishedAt: string | null
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null)

/** PURE. A record that is incomplete or malformed gives null = nothing is offered (fail closed). `enabled` must be exactly true; the roll-out defaults to 100. */
export function parseRelease(raw: unknown): Release | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const version = str(r.version), edSignature = str(r.edSignature), path = str(r.path)
  const build = typeof r.build === "number" && Number.isInteger(r.build) && r.build > 0 ? r.build : null
  const length = typeof r.length === "number" && Number.isInteger(r.length) && r.length > 0 ? r.length : null
  if (!version || !edSignature || !path || !build || !length) return null
  if (!/^\d+(\.\d+){0,3}$/.test(version) || path.includes("..") || path.startsWith("/")) return null
  const pct = typeof r.rolloutPercent === "number" && Number.isFinite(r.rolloutPercent) ? Math.min(100, Math.max(0, r.rolloutPercent)) : 100
  return {
    version, build, edSignature, length, path,
    notes: str(r.notes) ?? "",
    minSystem: str(r.minSystem) && /^\d+(\.\d+){0,2}$/.test(str(r.minSystem)!) ? str(r.minSystem)! : "13.0",
    enabled: r.enabled === true,
    rolloutPercent: pct,
    publishedAt: str(r.publishedAt),
  }
}

/** PURE: a stable 0–99 bucket for one Mac (the same Mac is always in the same bucket, so a 10% roll-out grows to 20% without reshuffling). */
export function rolloutBucket(deviceId: string): number {
  let h = 2166136261
  for (let i = 0; i < deviceId.length; i++) { h ^= deviceId.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h % 100
}

/** PURE: is this release offered to this Mac? Paused → nobody. 100% → everybody. Less → only Macs that name themselves and fall in the share. */
export function isOffered(rel: Release | null, deviceId: string | null): boolean {
  if (!rel || !rel.enabled) return false
  if (rel.rolloutPercent >= 100) return true
  if (!deviceId || rel.rolloutPercent <= 0) return false
  return rolloutBucket(deviceId) < rel.rolloutPercent
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** PURE: the Sparkle feed. `null` release or `null` url = an empty feed (nothing to install). */
export function buildAppcast(rel: Release | null, url: string | null): string {
  const head = `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">\n<channel>\n<title>TD Storage</title>\n`
  if (!rel || !url) return head + `</channel>\n</rss>\n`
  const date = rel.publishedAt ? new Date(rel.publishedAt) : null
  return head + `<item>
<title>Version ${xml(rel.version)}</title>
<sparkle:version>${rel.build}</sparkle:version>
<sparkle:shortVersionString>${xml(rel.version)}</sparkle:shortVersionString>
<sparkle:minimumSystemVersion>${xml(rel.minSystem)}</sparkle:minimumSystemVersion>
${date && !Number.isNaN(date.getTime()) ? `<pubDate>${date.toUTCString()}</pubDate>\n` : ""}<description><![CDATA[${rel.notes.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]></description>
<enclosure url="${xml(url)}" length="${rel.length}" type="application/octet-stream" sparkle:edSignature="${xml(rel.edSignature)}"/>
</item>\n</channel>\n</rss>\n`
}

/** Read the row; any error → null (nothing offered). */
export async function loadRelease(): Promise<Release | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- app_settings value is jsonb
    const { data, error } = await (supabaseAdmin as any).from("app_settings").select("value").eq("key", RELEASE_KEY).maybeSingle()
    if (error) return null
    return parseRelease(data?.value)
  } catch { return null }
}

/** A short-lived link to the zip (null when it cannot be made). `filename` makes a browser save it under that name. */
export async function signedZipUrl(rel: Release, seconds: number, filename?: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.storage.from(RELEASE_BUCKET).createSignedUrl(rel.path, seconds, filename ? { download: filename } : undefined)
  return error || !data?.signedUrl ? null : data.signedUrl
}
