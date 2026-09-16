/**
 * ShipStation V2 API — read-only label lookup by tracking number.
 *
 * Verified live (2026-09-09) against the real account: for a label CREATED THROUGH
 * ShipStation, GET /v2/labels?tracking_number=X is free on the existing account key —
 * it is NOT the arbitrary-carrier tracking lookup that requires the paid "Advanced" plan
 * (that gate is on a different endpoint, for shipments never created through ShipStation).
 * Confirmed against the published OpenAPI spec: auth is an `api-key` header, the query
 * parameter is `tracking_number`, and the response is `{ labels: [...] }` — an array,
 * empty when nothing matches (a label was bought outside ShipStation, or the number was
 * mistyped) rather than a 404.
 *
 * `tracking_status` is one of exactly four values: unknown | in_transit | error |
 * delivered. Only `delivered` means anything to the caller here.
 *
 * 2026-09-16: when a label is delivered, a SECOND call to GET /v2/labels/{label_id}/track
 * fetches the carrier's own `actual_delivery_date` (per ShipStation's published docs) —
 * this closed a real bug where the daily cron stamped "the moment we checked" as the
 * delivery date instead of the carrier's real one. Whether /track sits behind the same
 * paid-plan gate as the arbitrary-carrier lookup above is NOT confirmed against a live
 * call (no ShipStation key available outside production). This function fails SOFT on
 * that second call by design — any failure (network, timeout, non-2xx, a missing field,
 * or a plan gate) returns `actualDeliveryDate: null`, never a thrown error. The caller
 * (decideCheckOutcome in lib/operations/irs-tracking.ts) has its own bounded grace period
 * for exactly this case, so a permanently-unavailable /track endpoint degrades to "this
 * fix doesn't help," never to a broken cron.
 */

const SHIPSTATION_API_BASE = 'https://api.shipstation.com/v2'
const REQUEST_TIMEOUT_MS = 10_000

export type ShipStationTrackingStatus = 'unknown' | 'in_transit' | 'error' | 'delivered'

export type ShipStationLookupResult =
  | { found: true; status: ShipStationTrackingStatus; shipDate: string | null; actualDeliveryDate: string | null }
  | { found: false }

function requireApiKey(): string {
  const key = process.env.SHIPSTATION_V2_API_KEY
  if (!key) throw new Error('SHIPSTATION_V2_API_KEY is not set')
  return key
}

async function fetchWithTimeout(url: string, apiKey: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { method: 'GET', headers: { 'api-key': apiKey }, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch the carrier's real delivery timestamp for an already-delivered label. Never
 * throws — see the file header for why a failure here must never abort the caller.
 */
async function fetchActualDeliveryDate(labelId: string, apiKey: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(`${SHIPSTATION_API_BASE}/labels/${encodeURIComponent(labelId)}/track`, apiKey)
    if (!res.ok) return null
    const body = (await res.json()) as { actual_delivery_date?: string | null }
    return body.actual_delivery_date ?? null
  } catch {
    return null
  }
}

/**
 * Look up a label by its tracking number. Throws on a network/HTTP failure of the
 * PRIMARY (list-labels) call — the caller should treat that as "skip this check, retry
 * next run," NOT the same as a clean "no label found" answer, which this function
 * reports as `{ found: false }`. The secondary delivery-date fetch never throws.
 */
export async function lookupTrackingStatus(trackingNumber: string): Promise<ShipStationLookupResult> {
  const apiKey = requireApiKey()
  const url = `${SHIPSTATION_API_BASE}/labels?tracking_number=${encodeURIComponent(trackingNumber)}`
  const res = await fetchWithTimeout(url, apiKey)
  if (!res.ok) {
    throw new Error(`ShipStation lookup failed: ${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as {
    labels?: Array<{ label_id?: string; tracking_status?: string; ship_date?: string | null }>
  }
  const label = body.labels?.[0]
  if (!label) return { found: false }
  const status = (label.tracking_status as ShipStationTrackingStatus | undefined) ?? 'unknown'
  const actualDeliveryDate =
    status === 'delivered' && label.label_id ? await fetchActualDeliveryDate(label.label_id, apiKey) : null
  return {
    found: true,
    status,
    shipDate: label.ship_date ?? null,
    actualDeliveryDate,
  }
}
