import { redirect } from 'next/navigation'
import { getClientAppMode } from '@/lib/app-mode/server'
import { APP_BILLING_TAB } from '@/lib/portal-app/invoices'

/**
 * Legacy billing page — redirects to the Expenses tab on the invoices page.
 * Billing has been absorbed into /portal/invoices?tab=expenses.
 *
 * Inside the client iPhone app (dev job 056a70d0, Step 3c) the TD Billing entry opens the app's own TD Billing screen instead,
 * which the invoices page draws for `?tab=billing`. The website is unchanged.
 */
export default function PortalBillingPage() {
  redirect(getClientAppMode() ? `/portal/invoices?tab=${APP_BILLING_TAB}` : '/portal/invoices?tab=expenses')
}
