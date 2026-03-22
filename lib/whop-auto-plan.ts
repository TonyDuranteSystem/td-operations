/**
 * Auto-create a Whop checkout plan for an offer.
 *
 * Given the client name, total amount, and currency, creates a Whop plan
 * under the appropriate product and returns the checkout URL.
 *
 * Products are matched by service type:
 * - LLC Formation → prod_nzrLiGLomSYZT
 * - LLC Onboarding → prod_X6mwSZhW9GqPW
 * - Tax Return → find or create
 * - ITIN → find or create
 * - Default → LLC Formation product
 */

const WHOP_API_BASE = 'https://api.whop.com/api/v1'
const COMPANY_ID = 'biz_rssyD9YyMnXd7P'

// Known product IDs
const PRODUCT_MAP: Record<string, string> = {
  'formation': 'prod_nzrLiGLomSYZT',
  'onboarding': 'prod_X6mwSZhW9GqPW',
  'tax_return': 'prod_nzrLiGLomSYZT', // fallback to formation product
  'itin': 'prod_nzrLiGLomSYZT',       // fallback
}

interface AutoPlanResult {
  success: boolean
  planId?: string
  checkoutUrl?: string
  error?: string
}

export async function createWhopPlan(params: {
  clientName: string
  amount: number
  currency: 'usd' | 'eur'
  contractType: string
  serviceName?: string
}): Promise<AutoPlanResult> {
  const apiKey = process.env.WHOP_API_KEY
  if (!apiKey) {
    return { success: false, error: 'WHOP_API_KEY not set' }
  }

  const { clientName, amount, currency, contractType, serviceName } = params
  const productId = PRODUCT_MAP[contractType] || PRODUCT_MAP['formation']
  const title = serviceName
    ? `${serviceName} - ${clientName}`
    : `${contractType === 'formation' ? 'LLC Formation' : contractType === 'onboarding' ? 'LLC Onboarding' : contractType} - ${clientName}`

  try {
    const res = await fetch(`${WHOP_API_BASE}/plans`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product_id: productId,
        company_id: COMPANY_ID,
        plan_type: 'one_time',
        initial_price: amount,
        currency: currency,
        title: title.slice(0, 30), // Whop title limit is 30 chars
        visibility: 'hidden', // Only accessible via direct link
      }),
    })

    if (!res.ok) {
      const errBody = await res.text()
      console.error('[whop-auto-plan] Create failed:', errBody)
      return { success: false, error: `Whop API error: ${res.status}` }
    }

    const plan = await res.json() as { id: string }
    const checkoutUrl = `https://whop.com/checkout/${plan.id}`

    console.log(`[whop-auto-plan] Created plan ${plan.id} for ${clientName}: ${currency.toUpperCase()} ${amount}`)

    return {
      success: true,
      planId: plan.id,
      checkoutUrl,
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
