/** Browser-safe (no server imports): the plain-language reason key shown to a client (see invDelivery.reason.* in lib/portal/i18n.ts). */
export function deliveryReasonKey(detail: string | null): 'suppressed' | 'bounced' | 'failed' {
  return detail === 'suppressed' ? 'suppressed' : detail === 'bounced' ? 'bounced' : 'failed'
}
