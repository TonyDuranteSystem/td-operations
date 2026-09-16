/**
 * Payment-instructions copy shared by the 1st and 2nd installment invoice
 * creators (agreement-signed webhook, annual-installments cron).
 *
 * A portal-audience client (portal_tier active/onboarding/formation) already
 * gets a "log in to your portal to pay" push in the invoice email body and
 * Pay button — offering wire-transfer/card instructions in the invoice's own
 * message field too contradicts that, and previously happened unconditionally
 * regardless of audience (found while investigating dev job 9eb541a5;
 * tracked as its sibling finding). Kept as one shared constant so the two
 * templates' portal-facing wording can't drift from each other.
 */
export const PORTAL_INSTALLMENT_PAYMENT_INSTRUCTION =
  "Please log in to your portal to pay this invoice — go to Billing."
