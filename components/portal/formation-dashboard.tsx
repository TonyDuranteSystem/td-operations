'use client'

import { CheckCircle, Clock, AlertCircle, ArrowRight, Building2, MapPin, Calendar, Shield, MessageCircle, FileText } from 'lucide-react'
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
  /** Active Company Closure SD on the contact, if any. Renders a Closure CTA
   * when the same client also has a closure bundled with their formation (a
   * NEW LLC being formed AND an external LLC being wound down). Patrick
   * Covelli is the canonical case. */
  closureData?: { id: string } | null
  /** Lead the in-progress formation is anchored on. When set, the step-2
   * "Fill In Your LLC Details" action links to /portal/wizard?lead=<leadId>.
   * Required for returning clients who already own an account — without it the
   * wizard page falls through to that account's context and opens the wrong
   * wizard (tax/onboarding) instead of this new company's formation. */
  formationLeadId?: string | null
}

/** Visual state of a single tracker milestone. */
type MilestoneState = 'completed' | 'action' | 'waiting' | 'upcoming'

export function FormationDashboard({
  firstName,
  locale,
  account,
  wizardData,
  ss4Data,
  oaData,
  leaseData,
  closureData,
  formationLeadId,
}: FormationDashboardProps) {
  const tr = locale === 'it' ? IT : EN
  // New-company formations are lead-anchored: the wizard page only enters the
  // formation scope via ?lead=. Carry it so returning clients (who already own
  // an account) aren't routed to that account's wizard. Falls back to the bare
  // path for the fresh-client case where no account exists to fall through to.
  const wizardHref = formationLeadId
    ? `/portal/wizard?lead=${formationLeadId}`
    : '/portal/wizard'

  // ── Raw signals (unchanged) ──
  const wizardSubmitted = wizardData?.status === 'submitted' || wizardData?.status === 'completed'
  const stateConfirmed = !!account?.filing_id || !!account?.formation_date
  const ss4AwaitingSignature = ss4Data?.status === 'awaiting_signature'
  const ss4Signed = ss4Data?.status === 'signed' || ss4Data?.status === 'submitted' || ss4Data?.status === 'confirmed'
  const ss4Faxed = ss4Data?.status === 'submitted' || ss4Data?.status === 'confirmed'
  const einReceived = !!account?.ein_number
  const oaSigned = oaData?.status === 'signed'
  const leaseSigned = leaseData?.status === 'signed'

  // ── Milestone completion (monotonic cascade) ──
  // A later milestone being reached implies every earlier one is done, so a
  // backstop (||einReceived etc.) prevents an upstream step from rendering gray
  // when a downstream one is already complete (e.g. EIN entered manually).
  const m2Done = wizardSubmitted || stateConfirmed || einReceived
  const m345Done = stateConfirmed || einReceived
  const m6Done = ss4Signed || einReceived
  const m7Done = ss4Faxed || einReceived
  const m8Done = einReceived

  // ── Per-step visual state ──
  const m2State: MilestoneState = m2Done ? 'completed' : 'action'
  const m3State: MilestoneState = m345Done ? 'completed' : m2Done ? 'waiting' : 'upcoming'
  const m4State: MilestoneState = m345Done ? 'completed' : 'upcoming'
  const m5State: MilestoneState = m345Done ? 'completed' : 'upcoming'
  // Once the LLC is approved, the SS-4 is being prepared by our team until it's
  // ready for the client's signature — show that as a blue "waiting" dot (mirrors
  // steps 7 & 8) rather than a gray "upcoming" one.
  const m6State: MilestoneState = m6Done ? 'completed' : ss4AwaitingSignature ? 'action' : m345Done ? 'waiting' : 'upcoming'
  const m7State: MilestoneState = m7Done ? 'completed' : m6Done ? 'waiting' : 'upcoming'
  const m8State: MilestoneState = m8Done ? 'completed' : m7Done ? 'waiting' : 'upcoming'

  // ── Post-EIN CTAs (kept; independent of the tracker) ──
  const needsOA = einReceived && !oaSigned && oaData && oaData.status !== 'signed'
  const needsLease = einReceived && !leaseSigned && leaseData && leaseData.status !== 'signed'
  // Closure is INDEPENDENT of the formation milestone chain — it surfaces
  // whenever an active Closure SD exists on the contact, regardless of stage.
  const needsClosure = !!closureData

  // Informational waiting banners (timelines the tracker dots can't convey)
  const waitingForState = m2Done && !m345Done
  const waitingForEIN = m7Done && !einReceived

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
      {/* Soft amber glow for client-action steps */}
      <style jsx global>{`
        @keyframes formationActionGlow {
          0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
          50% { box-shadow: 0 0 0 5px rgba(245, 158, 11, 0.18); }
        }
        .formation-action-glow { animation: formationActionGlow 2.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .formation-action-glow { animation: none; }
        }
      `}</style>

      {/* Welcome header */}
      <div className="bg-gradient-to-r from-indigo-600 to-indigo-700 rounded-2xl p-6 sm:p-8 text-white">
        <h1 className="text-2xl sm:text-3xl font-bold mb-2">
          {tr.welcome}, {firstName}! 👋
        </h1>
        <p className="text-indigo-100 text-sm sm:text-base">{tr.subtitle}</p>
      </div>

      {/* Post-EIN CTAs — the wizard (step 2) and SS-4 (step 6) actions now live
          inside the tracker; only the post-EIN document signings float here. */}
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

      {needsClosure && (
        <Link
          href="/portal/wizard?type=closure"
          className="flex items-center gap-4 p-5 bg-rose-50 border-2 border-rose-300 rounded-xl hover:bg-rose-100 transition-colors group"
        >
          <div className="h-12 w-12 rounded-xl bg-rose-600 flex items-center justify-center shrink-0">
            <AlertCircle className="h-6 w-6 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-base font-semibold text-rose-900">{tr.ctaClosureTitle}</p>
            <p className="text-sm text-rose-700 mt-0.5">{tr.ctaClosureDesc}</p>
          </div>
          <ArrowRight className="h-5 w-5 text-rose-500 shrink-0 group-hover:translate-x-1 transition-transform" />
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
          <Milestone label={tr.m1Label} desc={tr.m1Desc} state="completed" actionLabel={tr.actionRequired} />
          <MilestoneConnector completed={true} />
          <Milestone label={tr.m2Label} desc={tr.m2Desc} state={m2State} href={wizardHref} actionLabel={tr.actionRequired} />
          <MilestoneConnector completed={m2Done} />
          <Milestone label={tr.m3Label} desc={tr.m3Desc} state={m3State} actionLabel={tr.actionRequired} />
          <MilestoneConnector completed={m345Done} />
          <Milestone label={tr.m4Label} desc={tr.m4Desc} state={m4State} actionLabel={tr.actionRequired} />
          <MilestoneConnector completed={m345Done} />
          <Milestone label={tr.m5Label} desc={tr.m5Desc} state={m5State} actionLabel={tr.actionRequired} />
          <MilestoneConnector completed={m6Done} />
          <Milestone label={tr.m6Label} desc={tr.m6Desc} state={m6State} href="/portal/sign/ss4" actionLabel={tr.actionRequired} />
          <MilestoneConnector completed={m6Done} />
          <Milestone label={tr.m7Label} desc={tr.m7Desc} state={m7State} actionLabel={tr.actionRequired} />
          <MilestoneConnector completed={m7Done} />
          <Milestone label={tr.m8Label} desc={tr.m8Desc} state={m8State} actionLabel={tr.actionRequired} />
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

/**
 * One tracker milestone. `state` drives the visual:
 *  - completed → green check
 *  - action    → amber glow + "Action required" badge + clickable (needs href)
 *  - waiting   → blue pulsing dot (we're working / waiting on a third party)
 *  - upcoming  → gray dot
 */
function Milestone({
  label,
  desc,
  state,
  href,
  actionLabel,
}: {
  label: string
  desc: string
  state: MilestoneState
  href?: string
  actionLabel: string
}) {
  const isCompleted = state === 'completed'
  const isAction = state === 'action'
  const isWaiting = state === 'waiting'

  const circle = (
    <div
      className={`h-7 w-7 rounded-full flex items-center justify-center shrink-0 ${
        isCompleted ? 'bg-emerald-500' : isAction ? 'bg-amber-500' : isWaiting ? 'bg-blue-500' : 'bg-zinc-200'
      }`}
    >
      {isCompleted ? (
        <CheckCircle className="h-4 w-4 text-white" />
      ) : isAction ? (
        <AlertCircle className="h-4 w-4 text-white" />
      ) : isWaiting ? (
        <span className="h-2.5 w-2.5 rounded-full bg-white animate-pulse" />
      ) : (
        <span className="h-2.5 w-2.5 rounded-full bg-zinc-400" />
      )}
    </div>
  )

  const inner = (
    <>
      {circle}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p
            className={`text-sm font-medium ${
              isCompleted ? 'text-emerald-700' : isAction ? 'text-amber-800' : isWaiting ? 'text-blue-700' : 'text-zinc-400'
            }`}
          >
            {label}
          </p>
          {isAction && (
            <span className="inline-flex items-center rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
              {actionLabel}
            </span>
          )}
        </div>
        <p className="text-xs text-zinc-500">{desc}</p>
      </div>
      {isAction && <ArrowRight className="h-4 w-4 text-amber-500 shrink-0" />}
    </>
  )

  const base = 'flex items-center gap-3 p-3 rounded-lg'

  if (isAction && href) {
    return (
      <Link
        href={href}
        className={`${base} formation-action-glow border border-amber-300 bg-amber-50 hover:bg-amber-100 transition-colors`}
      >
        {inner}
      </Link>
    )
  }

  return (
    <div
      className={`${base} ${isCompleted ? 'bg-emerald-50/60' : isWaiting ? 'bg-blue-50 border border-blue-200' : 'bg-zinc-50'}`}
    >
      {inner}
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
  actionRequired: 'Action required',
  m1Label: 'Payment Confirmed',
  m1Desc: 'Your formation order is active',
  m2Label: 'Fill In Your LLC Details',
  m2Desc: 'We need your company info to file with the state',
  m3Label: 'We\'re Preparing Your Filing',
  m3Desc: 'Our team is reviewing your details',
  m4Label: 'Filed with the State',
  m4Desc: 'Articles sent to Secretary of State',
  m5Label: 'LLC Approved',
  m5Desc: 'Your LLC is officially registered',
  m6Label: 'Sign Your SS-4',
  m6Desc: 'Sign the IRS form for your EIN',
  m7Label: 'EIN Application Sent',
  m7Desc: 'We submitted your EIN application',
  m8Label: 'EIN Received — You\'re All Set',
  m8Desc: 'Your LLC is fully operational',
  ctaOATitle: 'Sign Your Operating Agreement',
  ctaOADesc: 'Your LLC\'s governing document is ready for your signature',
  ctaLeaseTitle: 'Sign Your Lease Agreement',
  ctaLeaseDesc: 'Your registered address lease is ready for your signature',
  ctaClosureTitle: 'Complete Your Company Closure Details',
  ctaClosureDesc: 'We need details about the company you\'re closing — name, EIN, and Articles of Organization',
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
  actionRequired: 'Azione richiesta',
  m1Label: 'Pagamento Confermato',
  m1Desc: 'Il tuo ordine di costituzione è attivo',
  m2Label: 'Inserisci i Dati della tua LLC',
  m2Desc: 'Ci servono le informazioni della tua società per registrarla presso lo Stato',
  m3Label: 'Stiamo Preparando la Registrazione',
  m3Desc: 'Il nostro team sta esaminando i tuoi dati',
  m4Label: 'Depositata presso lo Stato',
  m4Desc: 'Articles inviati al Segretario di Stato',
  m5Label: 'LLC Approvata',
  m5Desc: 'La tua LLC è ufficialmente registrata',
  m6Label: 'Firma il Modulo SS-4',
  m6Desc: 'Firma il modulo IRS per il tuo EIN',
  m7Label: 'Richiesta EIN Inviata',
  m7Desc: 'Abbiamo inviato la tua richiesta di EIN',
  m8Label: 'EIN Ricevuto — Tutto Pronto',
  m8Desc: 'La tua LLC è pienamente operativa',
  ctaOATitle: 'Firma il Tuo Operating Agreement',
  ctaOADesc: 'Il documento costitutivo della tua LLC è pronto per la firma',
  ctaLeaseTitle: 'Firma il Tuo Contratto di Locazione',
  ctaLeaseDesc: 'Il contratto per il tuo indirizzo registrato è pronto per la firma',
  ctaClosureTitle: 'Completa i Dati per la Chiusura della Società',
  ctaClosureDesc: 'Ci servono i dettagli della società che stai chiudendo — nome, EIN e Atto Costitutivo',
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
