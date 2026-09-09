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
 */

const SHIPSTATION_API_BASE = 'https://api.shipstation.com/v2'

export type ShipStationTrackingStatus = 'unknown' | 'in_transit' | 'error' | 'delivered'

export type ShipStationLookupResult =
  | { found: true; status: ShipStationTrackingStatus; shipDate: string | null }
  | { found: false }

function requireApiKey(): string {
  const key = process.env.SHIPSTATION_V2_API_KEY
  if (!key) throw new Error('SHIPSTATION_V2_API_KEY is not set')
  return key
}

/**
 * Look up a label by its tracking number. Throws on a network/HTTP failure (the caller
 * should treat that as "skip this check, retry next run" — NOT the same as a clean
 * "no label found" answer, which this function reports as `{ found: false }`).
 */
export async function lookupTrackingStatus(trackingNumber: string): Promise<ShipStationLookupResult> {
  const url = `${SHIPSTATION_API_BASE}/labels?tracking_number=${encodeURIComponent(trackingNumber)}`
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'api-key': requireApiKey() },
  })
  if (!res.ok) {
    throw new Error(`ShipStation lookup failed: ${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as { labels?: Array<{ tracking_status?: string; ship_date?: string | null }> }
  const label = body.labels?.[0]
  if (!label) return { found: false }
  return {
    found: true,
    status: (label.tracking_status as ShipStationTrackingStatus | undefined) ?? 'unknown',
    shipDate: label.ship_date ?? null,
  }
}
