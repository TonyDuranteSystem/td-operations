/**
 * Courier vocabulary + tracking-URL resolution for ITIN shipping tracking.
 *
 * The client enters the courier they used to mail their signed ITIN package to
 * the TD office plus the tracking number; staff (and the client) see a clickable
 * link to the courier's tracking page. Pure — no I/O.
 */

export const COURIERS = ['FedEx', 'DHL', 'UPS', 'USPS', 'Other'] as const
export type Courier = (typeof COURIERS)[number]

/** True if `value` is one of the known courier names. */
export function isCourier(value: string | null | undefined): value is Courier {
  return !!value && (COURIERS as readonly string[]).includes(value)
}

/**
 * Build a tracking URL for a courier + tracking number, or null when no public
 * URL applies (unknown courier, "Other", or an empty tracking number). The
 * number is URL-encoded. Pure.
 */
export function courierTrackingUrl(
  courier: string | null | undefined,
  trackingNumber: string | null | undefined,
): string | null {
  const num = (trackingNumber ?? '').trim()
  if (!num || !isCourier(courier)) return null
  const enc = encodeURIComponent(num)
  switch (courier) {
    case 'FedEx':
      return `https://www.fedex.com/fedextrack/?trknbr=${enc}`
    case 'UPS':
      return `https://www.ups.com/track?loc=en_US&tracknum=${enc}`
    case 'DHL':
      return `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${enc}`
    case 'USPS':
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${enc}`
    case 'Other':
      return null
  }
}
