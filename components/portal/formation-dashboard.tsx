'use client'

import { CheckCircle, Clock, AlertCircle, ArrowRight, Building2, MapPin, Calendar, Shield, MessageCircle, PenSquare, FileText } from 'lucide-react'
import Link from 'next/link'

interface FormationAccount {
  id: string
  company_name: string | null
  entity_type: string | null
  state_of_formation: string | null
  formation_date: string | null
  filing_id: string | null
  status: string | null
  ein_number: string | null
}

interface FormationDashboardProps {
  firstName: string
  locale: 'en' | 'it'
  account: FormationAccount | null
  wizardData: { id: string; status: string } | null
  ss4Data: { id: string; status: string } | null
  oaData: { id: string; status: string } | null
  leaseData: { id: string; status: string } | null
}

export function FormationDashboard({
  firstName,
  locale,
  account,
  wizardData,
  ss4Data,
  oaData,
  leaseData,
}: FormationDashboardProps) {
  const tr = locale === 'it' ? IT : EN

  // Derive milestone completion
  const wizardSubmitted = wizardData?.status === 'submitted' || wizardData?.status === 'completed'
  const stateConfirmed = !!account?.filing_id || !!account?.formation_date
  const ss4Ready = !!ss4Data
  const ss4AwaitingSignature = ss4Data?.status === 'awaiting_signature'
  const ss4Signed = ss4Data?.status === 'signed' || ss4Data?.status === 'submitted' || ss4Data?.status === 'confirmed'
  const ss4Faxed = ss4Data?.status === 'submitted' || ss4Data?.status === 'confirmed'
  const einReceived = !!account?.ein_number
  const oaSigned = oaData?.status === 'signed'
  const leaseSigned = leaseData?.status === 'signed'

  // Determine current active CTA
  const needsWizard = !wizardSubmitted
  const needsSS4Signature = !needsWizard && ss4AwaitingSignature
  const needsOA = einReceived && !oaSigned && oaData && oaData.status !== 'signed'
  const needsLease = einReceived && !leaseSigned && leaseData && leaseData.status !== 'signed'

  // Status message for waiting states
  const waitingForState = wizardSubmitted && !stateConfirmed
  const waitingForEIN = ss4Faxed && !einReceived

  function formatDate(d: string | null): string {
    if (!d) return '—'
    try {
      const parsed = new Date(d)
      return parsed.toLocaleDateString(locale === 'it' ? 'it-IT' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    } catch {
      return d
    }
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
      {/* Welcome header */}
      <div className="bg-gradient-to-r from-indigo-600 to-indigo-700 rounded-2xl p-6 sm:p-8 text-white">
        <h1 className="text-2xl sm:text-3xl font-bold mb-2">
          {tr.welcome}, {firstName}! 👋
        </h1>
        <p className="text-indigo-100 text-sm sm:text-base">{tr.subtitle}</p>
      </div>

      {/* Active CTA — prominent card for the next required action */}
      {needsWizard && (
        <Link
          href="/portal/wizard"
          className="flex items-center gap-4 p-5 bg-indigo-50 border-2 border-indigo-300 rounded-xl hover:bg-indigo-100 transition-colors group"
        >
          <div className="h-12 w-12 rounded-xl bg-indigo-600 flex items-center justify-center shrink-0">
            <PenSquare className="h-6 w-6 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-base font-semibold text-indigo-900">{tr.ctaWizardTitle}</p>
            <p className="text-sm text-indigo-700 mt-0.5">{tr.ctaWizardDesc}</p>
          </div>
          <ArrowRight className="h-5 w-5 text-indigo-500 shrink-0 group-hover:translate-x-1 transition-transform" />
        </Link>
      )}

      {needsSS4Signature && (
        <Link
          href="/portal/sign/ss4"
          className="flex items-center gap-4 p-5 bg-amber-50 border-2 border-amber-300 rounded-xl hover:bg-amber-100 transition-colors group"
        >
          <div className="h-12 w-12 rounded-xl bg-amber-500 flex items-center justify-center shrink-0">
            <FileText className="h-6 w-6 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-base font-semibold text-amber-900">{tr.ctaSS4Title}</p>
            <p className="text-sm text-amber-700 mt-0.5">{tr.ctaSS4Desc}</p>
          </div>
          <ArrowRight className="h-5 w-5 text-amber-500 shrink-0 group-hover:translate-x-1 transition-transform" />
        </Link>
      )}

      {needsOA && (
        <Link
          href="/portal/sign/oa"
          className="flex items-center gap-4 p-5 bg-blue-50 border-2 border-blue-300 rounded-xl hover:bg-blue-100 transition-colors group"
        >
          <div className="h-12 w-12 rounded-xl bg-blue-600 flex items-center justify-center shrink-0">
            <FileText className="h-6 w-6 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-base font-semibold text-blue-900">{tr.ctaOATitle}</p>
            <p className="text-sm text-blue-700 mt-0.5">{tr.ctaOADesc}</p>
          </div>
          <ArrowRight className="h-5 w-5 text-blue-500 shrink-0 group-hover:translate-x-1 transition-transform" />
        </Link>
      )}

      {needsLease && (
        <Link
          href="/portal/sign/lease"
          className="flex items-center gap-4 p-5 bg-purple-50 border-2 border-purple-300 rounded-xl hover:bg-purple-100 transition-colors group"
        >
          <div className="h-12 w-12 rounded-xl bg-purple-600 flex items-center justify-center shrink-0">
            <FileText className="h-6 w-6 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-base font-semibold text-purple-900">{tr.ctaLeaseTitle}</p>
            <p className="text-sm text-purple-700 mt-0.5">{tr.ctaLeaseDesc}</p>
          </div>
          <ArrowRight className="h-5 w-5 text-purple-500 shrink-0 group-hover:translate-x-1 transition-transform" />
        </Link>
      )}

      {/* Waiting state banners */}
      {waitingForState && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 flex items-start gap-3">
          <Clock className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-blue-900">{tr.waitingStateTitle}</p>
            <p className="text-sm text-blue-700 mt-1">{tr.waitingStateBody}</p>
          </div>
        </div>
      )}

      {waitingForEIN && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 flex items-start gap-3">
          <Clock className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-amber-900">{tr.waitingEINTitle}</p>
            <p className="text-sm text-amber-700 mt-1">{tr.waitingEINBody}</p>
          </div>
        </div>
      )}

      {/* Progress tracker */}
      <div className="bg-white rounded-xl border shadow-sm p-6">
        <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider mb-5">{tr.progressTitle}</h2>
        <div className="space-y-1">
          <Milestone
            label={tr.m1Label}
            desc={tr.m1Desc}
            completed={true}
          />
          <MilestoneConnector completed={true} />
          <Milestone
            label={tr.m2Label}
            desc={tr.m2Desc}
            completed={wizardSubmitted}
            active={!wizardSubmitted}
          />
          <MilestoneConnector completed={wizardSubmitted} />
          <Milestone
            label={tr.m3Label}
            desc={tr.m3Desc}
            completed={wizardSubmitted}
            active={wizardSubmitted && !stateConfirmed}
          />
          <MilestoneConnector completed={stateConfirmed} />
          <Milestone
            label={tr.m4Label}
            desc={tr.m4Desc}
            completed={stateConfirmed}
            active={wizardSubmitted && !stateConfirmed}
          />
          <MilestoneConnector completed={ss4Ready} />
          <Milestone
            label={tr.m5Label}
            desc={tr.m5Desc}
            completed={ss4Signed}
            active={ss4AwaitingSignature}
          />
          <MilestoneConnector completed={ss4Faxed} />
          <Milestone
            label={tr.m6Label}
            desc={tr.m6Desc}
            completed={ss4Faxed}
            active={ss4Signed && !ss4Faxed}
          />
          <MilestoneConnector completed={einReceived} />
          <Milestone
            label={tr.m7Label}
            desc={tr.m7Desc}
            completed={einReceived}
            active={ss4Faxed && !einReceived}
          />
          <MilestoneConnector completed={oaSigned && leaseSigned} />
          <Milestone
            label={tr.m8Label}
            desc={tr.m8Desc}
            completed={oaSigned && leaseSigned}
            active={einReceived && (!oaSigned || !leaseSigned)}
          />
        </div>
      </div>

      {/* Company info */}
      {account && (
        <div className="bg-white rounded-xl border shadow-sm p-5 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">{tr.companyInfo}</h2>
          <div className="space-y-2.5 text-sm">
            {account.company_name && (
              <InfoRow icon={Building2} label={tr.companyName} value={account.company_name} />
            )}
            {account.entity_type && (
              <InfoRow icon={Building2} label={tr.entityType} value={account.entity_type} />
            )}
            {account.state_of_formation && (
              <InfoRow icon={MapPin} label={tr.state} value={account.state_of_formation} />
            )}
            {account.formation_date && (
              <InfoRow icon={Calendar} label={tr.formationDate} value={formatDate(account.formation_date)} />
            )}
            {account.ein_number && (
              <InfoRow icon={Shield} label={tr.ein} value={account.ein_number} />
            )}
            {account.filing_id && (
              <InfoRow icon={FileText} label={tr.filingId} value={account.filing_id} />
            )}
          </div>
        </div>
      )}

      {/* Status info when all good */}
      {einReceived && oaSigned && leaseSigned && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-5 flex items-start gap-3">
          <CheckCircle className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-emerald-900">{tr.allDoneTitle}</p>
            <p className="text-sm text-emerald-700 mt-1">{tr.allDoneBody}</p>
          </div>
        </div>
      )}

      {/* Chat CTA */}
      <Link
        href="/portal/chat"
        className="flex items-center gap-3 p-4 bg-white rounded-xl border hover:border-green-300 hover:shadow-sm transition-all group"
      >
        <div className="h-10 w-10 rounded-lg bg-green-50 flex items-center justify-center group-hover:bg-green-100 transition-colors shrink-0">
          <MessageCircle className="h-5 w-5 text-green-600" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold">{tr.chatTitle}</p>
          <p className="text-xs text-zinc-500">{tr.chatDesc}</p>
        </div>
        <ArrowRight className="h-4 w-4 text-zinc-400 group-hover:text-green-500 transition-colors" />
      </Link>
    </div>
  )
}

// ─── Sub-components ───

function Milestone({ label, desc, completed, active = false }: { label: string; desc: string; completed: boolean; active?: boolean }) {
  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg ${active ? 'bg-indigo-50 border border-indigo-200' : completed ? 'bg-emerald-50/60' : 'bg-zinc-50'}`}>
      <div className={`h-7 w-7 rounded-full flex items-center justify-center shrink-0 ${completed ? 'bg-emerald-500' : active ? 'bg-indigo-500' : 'bg-zinc-200'}`}>
        {completed ? (
          <CheckCircle className="h-4 w-4 text-white" />
        ) : active ? (
          <AlertCircle className="h-4 w-4 text-white" />
        ) : (
          <span className="h-2.5 w-2.5 rounded-full bg-zinc-400" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${completed ? 'text-emerald-700' : active ? 'text-indigo-700' : 'text-zinc-400'}`}>
          {label}
        </p>
        <p className="text-xs text-zinc-500">{desc}</p>
      </div>
    </div>
  )
}

function MilestoneConnector({ completed }: { completed: boolean }) {
  return (
    <div className="flex items-center pl-6">
      <div className={`w-0.5 h-4 rounded-full ${completed ? 'bg-emerald-400' : 'bg-zinc-200'}`} />
    </div>
  )
}

function InfoRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="flex items-start sm:items-center gap-2">
      <Icon className="h-4 w-4 text-zinc-400 shrink-0 mt-0.5 sm:mt-0" />
      <div className="flex flex-col sm:flex-row sm:gap-2 min-w-0">
        <span className="text-zinc-500 text-xs sm:text-sm sm:min-w-[130px] shrink-0">{label}</span>
        <span className="font-medium text-zinc-900 text-sm break-words">{value}</span>
      </div>
    </div>
  )
}

// ─── Translations ───

const EN = {
  welcome: 'Welcome',
  subtitle: 'We\'re forming your LLC. Here\'s where things stand.',
  progressTitle: 'Formation Progress',
  m1Label: 'Payment Confirmed',
  m1Desc: 'Your formation order is active',
  m2Label: 'Formation Data Submitted',
  m2Desc: 'Your details submitted to our team',
  m3Label: 'State Filing Submitted',
  m3Desc: 'Articles of Organization filed with the Secretary of State',
  m4Label: 'LLC Officially Formed',
  m4Desc: 'State has approved and confirmed your LLC',
  m5Label: 'SS-4 Signed',
  m5Desc: 'IRS EIN application form signed by you',
  m6Label: 'SS-4 Faxed to IRS',
  m6Desc: 'Application submitted to the IRS',
  m7Label: 'EIN Received',
  m7Desc: 'Your federal Employer Identification Number is assigned',
  m8Label: 'Post-Formation Setup',
  m8Desc: 'Operating Agreement, Lease Agreement, and banking setup',
  ctaWizardTitle: 'Complete Your Formation Details',
  ctaWizardDesc: 'We need your information to file your LLC with the state',
  ctaSS4Title: 'Sign Your SS-4 Form',
  ctaSS4Desc: 'Your EIN application is ready — sign to proceed',
  ctaOATitle: 'Sign Your Operating Agreement',
  ctaOADesc: 'Your LLC\'s governing document is ready for your signature',
  ctaLeaseTitle: 'Sign Your Lease Agreement',
  ctaLeaseDesc: 'Your registered address lease is ready for your signature',
  waitingStateTitle: 'Your LLC is being filed',
  waitingStateBody: 'We\'ve submitted your Articles of Organization to the Secretary of State. Processing time varies by state — typically 1–4 weeks. We\'ll update you as soon as we hear back.',
  waitingEINTitle: 'EIN Application Submitted to the IRS',
  waitingEINBody: 'Your SS-4 form has been faxed to the IRS. EIN numbers typically arrive within 4–6 weeks. We\'ll notify you as soon as it\'s received.',
  allDoneTitle: 'Your formation is complete!',
  allDoneBody: 'Your LLC is formed, your EIN is assigned, and all documents are signed. Welcome to Tony Durante LLC services.',
  companyInfo: 'Company Information',
  companyName: 'Company',
  entityType: 'Entity Type',
  state: 'State',
  formationDate: 'Formation Date',
  ein: 'EIN',
  filingId: 'Filing ID',
  chatTitle: 'Have Questions?',
  chatDesc: 'Chat with our team anytime',
}

const IT = {
  welcome: 'Benvenuto',
  subtitle: 'Stiamo costituendo la tua LLC. Ecco a che punto siamo.',
  progressTitle: 'Avanzamento Costituzione',
  m1Label: 'Pagamento Confermato',
  m1Desc: 'Il tuo ordine di costituzione è attivo',
  m2Label: 'Dati di Costituzione Inviati',
  m2Desc: 'I tuoi dati sono stati inviati al nostro team',
  m3Label: 'Deposito Statale Inviato',
  m3Desc: 'Articles of Organization depositati presso il Segretario di Stato',
  m4Label: 'LLC Ufficialmente Costituita',
  m4Desc: 'Lo Stato ha approvato e confermato la tua LLC',
  m5Label: 'SS-4 Firmato',
  m5Desc: 'Modulo di richiesta EIN firmato da te',
  m6Label: 'SS-4 Inviato all\'IRS',
  m6Desc: 'Domanda presentata all\'IRS',
  m7Label: 'EIN Ricevuto',
  m7Desc: 'Il tuo Employer Identification Number federale è assegnato',
  m8Label: 'Setup Post-Costituzione',
  m8Desc: 'Operating Agreement, Contratto di Locazione e apertura conto corrente',
  ctaWizardTitle: 'Completa i Dati di Costituzione',
  ctaWizardDesc: 'Abbiamo bisogno delle tue informazioni per registrare la LLC presso lo Stato',
  ctaSS4Title: 'Firma il Tuo Modulo SS-4',
  ctaSS4Desc: 'La tua richiesta di EIN è pronta — firma per procedere',
  ctaOATitle: 'Firma il Tuo Operating Agreement',
  ctaOADesc: 'Il documento costitutivo della tua LLC è pronto per la firma',
  ctaLeaseTitle: 'Firma il Tuo Contratto di Locazione',
  ctaLeaseDesc: 'Il contratto per il tuo indirizzo registrato è pronto per la firma',
  waitingStateTitle: 'La tua LLC è in fase di registrazione',
  waitingStateBody: 'Abbiamo depositato i tuoi Articles of Organization presso il Segretario di Stato. I tempi di elaborazione variano per Stato — di solito 1–4 settimane. Ti aggiorneremo non appena riceveremo risposta.',
  waitingEINTitle: 'Richiesta EIN Inviata all\'IRS',
  waitingEINBody: 'Il tuo modulo SS-4 è stato inviato via fax all\'IRS. I numeri EIN arrivano tipicamente entro 4–6 settimane. Ti notificheremo non appena lo riceveremo.',
  allDoneTitle: 'La tua costituzione è completata!',
  allDoneBody: 'La tua LLC è costituita, il tuo EIN è assegnato e tutti i documenti sono firmati. Benvenuto nei servizi di Tony Durante LLC.',
  companyInfo: 'Informazioni Aziendali',
  companyName: 'Azienda',
  entityType: 'Tipo di Entità',
  state: 'Stato',
  formationDate: 'Data di Costituzione',
  ein: 'EIN',
  filingId: 'ID Registrazione',
  chatTitle: 'Hai Domande?',
  chatDesc: 'Chatta con il nostro team in qualsiasi momento',
}
