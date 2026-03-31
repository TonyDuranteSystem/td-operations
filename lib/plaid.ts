/**
 * Plaid client initialization
 * Used for bank account connections and transaction sync.
 *
 * Banks connected via Plaid: Chase, Relay, First Citizens, Mercury
 * Airwallex: separate integration via Airwallex REST API
 */

import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'

const configuration = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV as keyof typeof PlaidEnvironments ?? 'production'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID!,
      'PLAID-SECRET': process.env.PLAID_SECRET!,
    },
  },
})

export const plaidClient = new PlaidApi(configuration)

export const PLAID_PRODUCTS = ['transactions'] as const
export const PLAID_COUNTRY_CODES = ['US'] as const
