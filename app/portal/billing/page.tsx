import { redirect } from 'next/navigation'

/**
 * Legacy billing page — redirects to the Expenses tab on the invoices page.
 * Billing has been absorbed into /portal/invoices?tab=expenses.
 */
export default function PortalBillingPage() {
  redirect('/portal/invoices?tab=expenses')
}
