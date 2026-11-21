/**
 * When the invoice for a just-signed offer cannot be created, put it where staff look (dev job 709ac868).
 *
 * Signing itself still goes through, so the client now holds a signed contract and NO invoice, and the
 * bank-transfer reference they were given carries no invoice number. That used to land only in a function log
 * nobody tails — which is how a typed-payer save that production refused stayed invisible. "Loud" means seen:
 * one row in the system-errors list (deduplicated by the reporter), shown on System Health.
 *
 * Never throws: an alert that fails must not break signing.
 */
export async function reportInvoiceNotCreatedAtSigning(p: {
  offerToken: string
  contactId: string | null | undefined
  reason: string
}): Promise<void> {
  try {
    const { reportSystemError } = await import("@/lib/system-errors")
    await reportSystemError({
      source: "server",
      route: "/api/webhooks/offer-signed",
      message: `Invoice NOT created at signing on ${p.offerToken} — the client signed with no invoice: ${p.reason}`,
      context: { offer_token: p.offerToken, contact_id: p.contactId ?? null },
    })
  } catch (err) {
    console.error("[offer-signed] could not report the missing invoice:", err instanceof Error ? err.message : String(err))
  }
}
