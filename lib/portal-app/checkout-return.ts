/**
 * Client iPhone app — where the card page sends the client back to (dev job 056a70d0, bug-hunter fixes).
 *
 * Paying a Tony Durante invoice by card opens Stripe's page. On the website that is a side tab, and the usual "payment received" / "payment
 * cancelled" pages (on the offer site) are fine there. Inside the app the card page takes over the whole window, so after paying or
 * cancelling the client must come back to the portal's TD Billing screen, not to a plain page on another address.
 *
 * The app only says `return_to: "client_app"`; the addresses are fixed here (nothing from the request ever becomes an address, so there is
 * no open redirect). Anything else, or nothing, keeps the usual pages.
 */
import { PORTAL_BASE_URL } from '@/lib/config'

export const CLIENT_APP_RETURN_TO = 'client_app'

export interface CheckoutReturnUrls { success: string; cancel: string }

export function checkoutReturnUrls(returnTo: unknown): CheckoutReturnUrls | undefined {
  if (returnTo !== CLIENT_APP_RETURN_TO) return undefined
  return {
    success: `${PORTAL_BASE_URL}/portal/invoices?tab=billing&paid=1`,
    cancel: `${PORTAL_BASE_URL}/portal/invoices?tab=billing`,
  }
}
