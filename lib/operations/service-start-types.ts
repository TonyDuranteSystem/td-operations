/**
 * Which services send the S3 "your service has started" message. A tiny pure module so createSD can ask the question without
 * loading the notification code on every service it creates. The sending itself is lib/operations/service-start-notice.ts.
 *
 * Services where WE act first and nothing else tells the client: Public Notary, Shipping, Certificate of Incumbency,
 * EIN Change Name. These are the VALUES stored in service_deliveries.service_type (the catalog shows "Shipping" as "Shipping Service"). Company Change Name already asks for its names at creation, Company Closure keeps its welcome and its home-page
 * card, and Consulting Call is left out on purpose (Antonio, 2026-10-20).
 */
export const SERVICE_START_NOTICE_TYPES: readonly string[] = [
  'Public Notary',
  'Shipping',
  'Certificate of Incumbency',
  'EIN Change Name',
]

/** Pure: does this service type get the first message? */
export function wantsServiceStartNotice(serviceType: string | null | undefined): boolean {
  return !!serviceType && SERVICE_START_NOTICE_TYPES.includes(serviceType)
}
