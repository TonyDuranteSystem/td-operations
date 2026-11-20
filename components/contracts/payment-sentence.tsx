import type { ReactNode } from 'react'
import { feeIsWholeOffer, type PlanPaymentWording } from '@/lib/contracts/plan-payment-wording'
import { isRecurringPrice } from '@/lib/offers/compute-offer-totals'

/**
 * The fee-and-payment paragraph of a service agreement (section 5), shared by the short agreements and the add-on agreements inside
 * the formation / onboarding contract. Dev job 0f4941a2; wording approved by Antonio on 19 Nov 2026.
 *
 * With no usable plan it renders `legacy` untouched — each call site passes its own original sentence, so every offer without a plan
 * reads byte for byte as it always did. With a plan it states the Partial Payment schedule instead of "payable in full".
 */
export function PaymentSentence({ fee, plan, legacy }: { fee: string; plan?: PlanPaymentWording | null; legacy: ReactNode }) {
  // A recurring fee ("€500/year") is never part of a setup-fee plan: it keeps its ordinary sentence.
  if (!plan || isRecurringPrice(fee)) return <p>{legacy}</p>
  const whole = feeIsWholeOffer(fee, plan)
  return (
    <p>
      {whole ? (
        <>The total fee for this service is <strong>{fee}</strong>, paid as a Partial Payment schedule: {plan.lines}.</>
      ) : (
        <>The fee for this service is <strong>{fee}</strong>. It is part of one offer totalling {plan.total}, which is paid as a Partial Payment schedule: {plan.lines}.</>
      )}
      {plan.signingSeq !== null ? ` Work on this service begins once Part ${plan.signingSeq} is paid.` : ''}
      {' Payment may be made via credit/debit card or bank wire transfer as indicated in the offer.'}
    </p>
  )
}
