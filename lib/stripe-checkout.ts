/**
 * Create a Stripe Checkout Session for an offer.
 *
 * Mirrors the interface of whop-auto-plan.ts but uses Stripe Checkout.
 * Creates a one-time payment session and returns the hosted checkout URL.
 *
 * Key advantage over Whop: metadata carries offer_token and client_email,
 * enabling exact matching in the webhook (not just email-based).
 */

import StripeConstructor from "stripe"

type StripeClient = ReturnType<typeof StripeConstructor>

interface StripeCheckoutResult {
  success: boolean
  sessionId?: string
  checkoutUrl?: string
  error?: string
}

let _stripe: StripeClient | null = null
function getStripe(): StripeClient | null {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) return null
    // Stripe SDK v22: CJS types say function call, but ESM runtime may need `new`
    // Handle both cases to avoid "Class constructor cannot be invoked without new"
    try {
      _stripe = StripeConstructor(key)
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _stripe = new (StripeConstructor as any)(key)
    }
  }
  return _stripe
}

export async function createStripeCheckoutSession(params: {
  clientName: string
  amount: number       // in major units (e.g., 3000 for €3,000)
  currency: "usd" | "eur"
  contractType: string
  serviceName?: string
  clientEmail?: string
  offerToken?: string
  leadId?: string
}): Promise<StripeCheckoutResult> {
  const stripe = getStripe()
  if (!stripe) {
    return { success: false, error: "STRIPE_SECRET_KEY not set" }
  }

  const { clientName, amount, currency, contractType, serviceName, clientEmail, offerToken, leadId } = params

  const productName = serviceName
    || (contractType === "formation" ? "LLC Formation"
      : contractType === "onboarding" ? "LLC Onboarding"
        : contractType === "tax_return" ? "Tax Return"
          : contractType === "itin" ? "ITIN Application"
            : "Service")

  const description = `${productName} — ${clientName}`

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: clientEmail || undefined,
      line_items: [
        {
          price_data: {
            currency,
            unit_amount: Math.round(amount * 100), // Stripe uses cents
            product_data: {
              name: productName,
              description,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        offer_token: offerToken || "",
        lead_id: leadId || "",
        client_name: clientName,
        client_email: clientEmail || "",
        contract_type: contractType,
        source: "td-operations",
      },
      success_url: `${process.env.NEXT_PUBLIC_APP_URL || "https://app.tonydurante.us"}/offer/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL || "https://app.tonydurante.us"}/offer/payment-cancelled`,
    })

    console.warn(`[stripe-checkout] Created session ${session.id} for ${clientName}: ${currency.toUpperCase()} ${amount}`)

    return {
      success: true,
      sessionId: session.id,
      checkoutUrl: session.url || undefined,
    }
  } catch (err) {
    console.error("[stripe-checkout] Failed:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
