'use client'

import { FileText, CreditCard, CheckCircle, Clock, PenSquare, ArrowRight, Package, MessageCircle } from 'lucide-react'
import Link from 'next/link'
import { useLocale } from '@/lib/portal/use-locale'

interface OfferService {
  name: string
  price?: string
  description?: string
}

interface CostItem {
  label: string
  total?: string
  total_label?: string
}

interface WelcomeDashboardProps {
  tier: string
  firstName: string
  offerData: {
    token: string
    client_name: string
    status: string
    services: OfferService[] | null
    cost_summary: CostItem[] | null
    recurring_costs: { label: string; price: string }[] | null
    bundled_pipelines: string[] | null
    contract_type: string | null
    language: string | null
    payment_links: { url: string; label: string; amount: number }[] | null
    bank_details: { beneficiary?: string; account_number?: string; routing_number?: string; iban?: string; bic?: string; bank_name?: string } | null
    payment_type: string | null
  } | null
  /** True when an onboarding wizard_progress row exists with status='submitted'.
   *  Flips step 4 ("Complete Setup") from an active link into a passive
   *  "Data submitted — under review" state (Tier Model B, SOP v7.2). */
  wizardSubmitted?: boolean
}

export function WelcomeDashboard({ tier, firstName, offerData, wizardSubmitted = false }: WelcomeDashboardProps) {
  const isLead = tier === 'lead'
  const isFormation = tier === 'formation'
  const isOnboarding = tier === 'onboarding' || isFormation
  const isViewed = offerData?.status === 'viewed' || offerData?.status === 'signed' || offerData?.status === 'completed'
  const isSigned = offerData?.status === 'signed' || offerData?.status === 'completed'
  const isPaid = offerData?.status === 'completed'

  // Parse services from offer
  const services: OfferService[] = Array.isArray(offerData?.services) ? offerData.services : []

  const { t: translate } = useLocale()
  const t = {
    welcome: translate('welcomeDash.welcome'),
    leadSubtitle: translate('welcomeDash.leadSubtitle'),
    onboardingSubtitle: translate('welcomeDash.onboardingSubtitle'),
    yourProgress: translate('welcomeDash.yourProgress'),
    step1: translate('welcomeDash.step1'),
    step1Desc: translate('welcomeDash.step1Desc'),
    step2: translate('welcomeDash.step2'),
    step2Desc: translate('welcomeDash.step2Desc'),
    step3: translate('welcomeDash.step3'),
    step3Desc: translate('welcomeDash.step3Desc'),
    step4: translate('welcomeDash.step4'),
    step4Desc: translate('welcomeDash.step4Desc'),
    step4Review: translate('welcomeDash.step4Review'),
    step4ReviewDesc: translate('welcomeDash.step4ReviewDesc'),
    underReviewTitle: translate('welcomeDash.underReviewTitle'),
    underReviewBody: translate('welcomeDash.underReviewBody'),
    servicesPurchased: translate('welcomeDash.servicesPurchased'),
    viewProposal: translate('welcomeDash.viewProposal'),
    viewProposalDesc: translate('welcomeDash.viewProposalDesc'),
    completeSetup: translate('welcomeDash.completeSetup'),
    completeSetupDesc: translate('welcomeDash.completeSetupDesc'),
    chatWithUs: translate('welcomeDash.chatWithUs'),
    chatWithUsDesc: translate('welcomeDash.chatWithUsDesc'),
    requestService: translate('welcomeDash.requestService'),
    requestServiceDesc: translate('welcomeDash.requestServiceDesc'),
    paymentRequired: translate('welcomeDash.paymentRequired'),
    paymentDesc: translate('welcomeDash.paymentDesc'),
    payByCard: translate('welcomeDash.payByCard'),
    payByCardDesc: translate('welcomeDash.payByCardDesc'),
    cardFee: translate('welcomeDash.cardFee'),
    bankTransfer: translate('welcomeDash.bankTransfer'),
    noFee: translate('welcomeDash.noFee'),
    beneficiary: translate('welcomeDash.beneficiary'),
    accountNumber: translate('welcomeDash.accountNumber'),
    routingNumber: translate('welcomeDash.routingNumber'),
    bankName: translate('welcomeDash.bankName'),
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
      {/* Welcome header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-2xl p-6 sm:p-8 text-white">
        <h1 className="text-2xl sm:text-3xl font-bold mb-2">
          {t.welcome}, {firstName}! 👋
        </h1>
        <p className="text-blue-100 text-sm sm:text-base">
          {isLead ? t.leadSubtitle : t.onboardingSubtitle}
        </p>
      </div>

      {/* Progress steps */}
      <div className="bg-white rounded-xl border p-6">
        <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider mb-4">{t.yourProgress}</h2>
        <div className="space-y-3">
          <ProgressStep
            icon={FileText}
            label={t.step1}
            description={t.step1Desc}
            completed={isViewed}
            active={!isViewed && !!offerData}
            href={!isSigned ? '/portal/offer' : undefined}
          />
          <ProgressStep
            icon={CheckCircle}
            label={t.step2}
            description={t.step2Desc}
            completed={isSigned}
            active={isViewed && !isSigned}
            href={isLead && !isSigned ? '/portal/offer' : undefined}
          />
          <ProgressStep
            icon={CreditCard}
            label={t.step3}
            description={t.step3Desc}
            completed={isPaid}
            active={!!isSigned && !isPaid}
            href={isSigned && !isPaid ? '/portal/offer' : undefined}
          />
          <ProgressStep
            icon={wizardSubmitted ? Clock : PenSquare}
            label={wizardSubmitted ? t.step4Review : t.step4}
            description={wizardSubmitted ? t.step4ReviewDesc : t.step4Desc}
            completed={wizardSubmitted}
            active={isOnboarding && !wizardSubmitted}
            href={isOnboarding && !wizardSubmitted ? '/portal/wizard' : undefined}
          />
        </div>
      </div>

      {/* Under-review banner — shown when wizard is submitted but tier hasn't been
          promoted to active yet. Tells the client their data is in Antonio's
          review queue instead of a misleading "Complete Setup" link. */}
      {wizardSubmitted && isOnboarding && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 flex items-start gap-3">
          <Clock className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-blue-900">
              {t.underReviewTitle}
            </p>
            <p className="text-sm text-blue-700 mt-0.5">
              {t.underReviewBody}
            </p>
          </div>
        </div>
      )}

      {/* Payment section — shows when contract is signed but not paid, and payment methods exist */}
      {isSigned && !isPaid && (offerData?.payment_links?.length || offerData?.bank_details) && (
        <div className="bg-white rounded-xl border border-orange-200 p-6">
          <h2 className="text-sm font-semibold text-orange-600 uppercase tracking-wider mb-4">{t.paymentRequired}</h2>
          <p className="text-sm text-zinc-600 mb-4">{t.paymentDesc}</p>

          <div className="space-y-3">
            {/* Card payment */}
            {offerData?.payment_links?.map((link, i) => (
              <a
                key={i}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between p-4 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <CreditCard className="h-5 w-5" />
                  <div>
                    <p className="font-semibold">{t.payByCard}</p>
                    <p className="text-xs text-blue-200">{t.payByCardDesc}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-lg font-bold">${link.amount.toLocaleString()}</p>
                  <p className="text-xs text-blue-200">+5% {t.cardFee}</p>
                </div>
              </a>
            ))}

            {/* Bank transfer */}
            {offerData?.bank_details && (
              <div className="p-4 bg-zinc-50 rounded-xl border">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-lg">🏦</span>
                  <p className="font-semibold text-sm">{t.bankTransfer}</p>
                  <span className="text-xs text-zinc-400 ml-auto">{t.noFee}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {offerData.bank_details.beneficiary && (
                    <><span className="text-zinc-500">{t.beneficiary}</span><span className="font-medium">{offerData.bank_details.beneficiary}</span></>
                  )}
                  {offerData.bank_details.account_number && (
                    <><span className="text-zinc-500">{t.accountNumber}</span><span className="font-medium font-mono">{offerData.bank_details.account_number}</span></>
                  )}
                  {offerData.bank_details.routing_number && (
                    <><span className="text-zinc-500">{t.routingNumber}</span><span className="font-medium font-mono">{offerData.bank_details.routing_number}</span></>
                  )}
                  {offerData.bank_details.iban && (
                    <><span className="text-zinc-500">IBAN</span><span className="font-medium font-mono">{offerData.bank_details.iban}</span></>
                  )}
                  {offerData.bank_details.bank_name && (
                    <><span className="text-zinc-500">{t.bankName}</span><span className="font-medium">{offerData.bank_details.bank_name}</span></>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Services purchased (from offer) */}
      {services.length > 0 && (
        <div className="bg-white rounded-xl border p-6">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider mb-4">{t.servicesPurchased}</h2>
          <div className="grid gap-3">
            {services.map((svc, i) => (
              <div key={i} className="flex items-center gap-3 p-3 bg-zinc-50 rounded-lg">
                <Package className="h-5 w-5 text-blue-500 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium">{svc.name}</p>
                  {svc.description && (
                    <p className="text-xs text-zinc-500">{svc.description}</p>
                  )}
                </div>
                {svc.price && (
                  <span className="text-sm font-semibold text-zinc-700">{svc.price}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick actions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {isLead && (
          <Link
            href="/portal/offer"
            className="flex items-center gap-3 p-4 bg-white rounded-xl border hover:border-blue-300 hover:shadow-sm transition-all group"
          >
            <div className="h-10 w-10 rounded-lg bg-blue-50 flex items-center justify-center group-hover:bg-blue-100 transition-colors">
              <FileText className="h-5 w-5 text-blue-600" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold">{t.viewProposal}</p>
              <p className="text-xs text-zinc-500">{t.viewProposalDesc}</p>
            </div>
            <ArrowRight className="h-4 w-4 text-zinc-400 group-hover:text-blue-500 transition-colors" />
          </Link>
        )}
        {isOnboarding && !wizardSubmitted && (
          <Link
            href="/portal/wizard"
            className="flex items-center gap-3 p-4 bg-white rounded-xl border hover:border-blue-300 hover:shadow-sm transition-all group"
          >
            <div className="h-10 w-10 rounded-lg bg-blue-50 flex items-center justify-center group-hover:bg-blue-100 transition-colors">
              <PenSquare className="h-5 w-5 text-blue-600" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold">{t.completeSetup}</p>
              <p className="text-xs text-zinc-500">{t.completeSetupDesc}</p>
            </div>
            <ArrowRight className="h-4 w-4 text-zinc-400 group-hover:text-blue-500 transition-colors" />
          </Link>
        )}
        <Link
          href="/portal/chat"
          className="flex items-center gap-3 p-4 bg-white rounded-xl border hover:border-blue-300 hover:shadow-sm transition-all group"
        >
          <div className="h-10 w-10 rounded-lg bg-green-50 flex items-center justify-center group-hover:bg-green-100 transition-colors">
            <MessageCircle className="h-5 w-5 text-green-600" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold">{t.chatWithUs}</p>
            <p className="text-xs text-zinc-500">{t.chatWithUsDesc}</p>
          </div>
          <ArrowRight className="h-4 w-4 text-zinc-400 group-hover:text-green-500 transition-colors" />
        </Link>
        <Link
          href="/portal/services/request"
          className="flex items-center gap-3 p-4 bg-white rounded-xl border hover:border-blue-300 hover:shadow-sm transition-all group"
        >
          <div className="h-10 w-10 rounded-lg bg-purple-50 flex items-center justify-center group-hover:bg-purple-100 transition-colors">
            <Package className="h-5 w-5 text-purple-600" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold">{t.requestService}</p>
            <p className="text-xs text-zinc-500">{t.requestServiceDesc}</p>
          </div>
          <ArrowRight className="h-4 w-4 text-zinc-400 group-hover:text-purple-500 transition-colors" />
        </Link>
      </div>
    </div>
  )
}

// ─── Progress Step Component ───

function ProgressStep({
  icon: Icon,
  label,
  description,
  completed,
  active,
  href,
}: {
  icon: typeof FileText
  label: string
  description: string
  completed: boolean
  active: boolean
  href?: string
}) {
  const className = `flex items-center gap-4 p-3 rounded-lg transition-colors ${
    active ? 'bg-blue-50 border border-blue-200' : completed ? 'bg-green-50/50' : 'bg-zinc-50'
  } ${href ? 'cursor-pointer hover:shadow-sm' : ''}`

  const content = (
    <>
      <div className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${
        completed ? 'bg-green-500 text-white' : active ? 'bg-blue-500 text-white' : 'bg-zinc-200 text-zinc-400'
      }`}>
        {completed ? <CheckCircle className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${completed ? 'text-green-700' : active ? 'text-blue-700' : 'text-zinc-400'}`}>
          {label}
        </p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      {active && href && <ArrowRight className="h-4 w-4 text-blue-400 shrink-0" />}
    </>
  )

  if (href) {
    return <Link href={href} className={className}>{content}</Link>
  }
  return <div className={className}>{content}</div>
}

