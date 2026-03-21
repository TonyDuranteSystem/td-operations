'use client'

import { FileText, CreditCard, CheckCircle, PenSquare, ArrowRight, Package, MessageCircle } from 'lucide-react'
import Link from 'next/link'

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
    signed_at: string | null
    language: string | null
  } | null
  locale: 'en' | 'it'
}

export function WelcomeDashboard({ tier, firstName, offerData, locale }: WelcomeDashboardProps) {
  const isLead = tier === 'lead'
  const isOnboarding = tier === 'onboarding'
  const isSigned = offerData?.signed_at || offerData?.status === 'signed' || offerData?.status === 'completed'
  const isPaid = offerData?.status === 'completed'

  // Parse services from offer
  const services: OfferService[] = Array.isArray(offerData?.services) ? offerData.services : []
  const pipelines: string[] = Array.isArray(offerData?.bundled_pipelines) ? offerData.bundled_pipelines : []

  const t = locale === 'it' ? IT : EN

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
            completed={!!offerData}
            active={isLead && !isSigned}
            href={isLead && !isSigned ? '/portal/offer' : undefined}
          />
          <ProgressStep
            icon={CheckCircle}
            label={t.step2}
            description={t.step2Desc}
            completed={!!isSigned}
            active={isLead && !!offerData && !isSigned}
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
            icon={PenSquare}
            label={t.step4}
            description={t.step4Desc}
            completed={false}
            active={isOnboarding}
            href={isOnboarding ? '/portal/wizard' : undefined}
          />
        </div>
      </div>

      {/* Services purchased (from offer) */}
      {(services.length > 0 || pipelines.length > 0) && (
        <div className="bg-white rounded-xl border p-6">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider mb-4">{t.servicesPurchased}</h2>
          <div className="grid gap-3">
            {(pipelines.length > 0 ? pipelines : services.map(s => s.name)).map((name, i) => (
              <div key={i} className="flex items-center gap-3 p-3 bg-zinc-50 rounded-lg">
                <Package className="h-5 w-5 text-blue-500 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium">{name}</p>
                  {services[i]?.description && (
                    <p className="text-xs text-zinc-500">{services[i].description}</p>
                  )}
                </div>
                {services[i]?.price && (
                  <span className="text-sm font-semibold text-zinc-700">{services[i].price}</span>
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
        {isOnboarding && (
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

// ─── Translations ───

const EN = {
  welcome: 'Welcome',
  leadSubtitle: 'Your personalized proposal is ready. Review it, sign the contract, and make your payment to get started.',
  onboardingSubtitle: 'Thank you for your payment! Complete your setup so we can start working on your services.',
  yourProgress: 'Your Progress',
  step1: 'Review Proposal',
  step1Desc: 'Review the services and pricing we discussed',
  step2: 'Sign Contract',
  step2Desc: 'Accept the terms and sign the service agreement',
  step3: 'Make Payment',
  step3Desc: 'Complete your payment to activate services',
  step4: 'Complete Setup',
  step4Desc: 'Provide your information so we can get started',
  servicesPurchased: 'Services Included',
  viewProposal: 'View Your Proposal',
  viewProposalDesc: 'Review services, pricing, and sign the contract',
  completeSetup: 'Complete Your Setup',
  completeSetupDesc: 'Fill in your details to start the process',
  chatWithUs: 'Chat With Us',
  chatWithUsDesc: 'Ask questions or get help anytime',
}

const IT = {
  welcome: 'Benvenuto',
  leadSubtitle: 'La tua proposta personalizzata è pronta. Rivedi, firma il contratto e procedi con il pagamento.',
  onboardingSubtitle: 'Grazie per il pagamento! Completa la registrazione per iniziare a lavorare sui tuoi servizi.',
  yourProgress: 'Il Tuo Progresso',
  step1: 'Rivedi la Proposta',
  step1Desc: 'Rivedi i servizi e i prezzi che abbiamo discusso',
  step2: 'Firma il Contratto',
  step2Desc: 'Accetta i termini e firma il contratto di servizio',
  step3: 'Effettua il Pagamento',
  step3Desc: 'Completa il pagamento per attivare i servizi',
  step4: 'Completa la Registrazione',
  step4Desc: 'Fornisci le tue informazioni per iniziare',
  servicesPurchased: 'Servizi Inclusi',
  viewProposal: 'Visualizza la Proposta',
  viewProposalDesc: 'Rivedi servizi, prezzi e firma il contratto',
  completeSetup: 'Completa la Registrazione',
  completeSetupDesc: 'Inserisci i tuoi dati per avviare il processo',
  chatWithUs: 'Chatta Con Noi',
  chatWithUsDesc: 'Fai domande o chiedi aiuto in qualsiasi momento',
}
