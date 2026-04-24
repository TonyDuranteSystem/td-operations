'use client'

import {
  ArrowLeft, Globe, CheckCircle, ChevronRight, Info, MessageCircle,
} from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'
import Link from 'next/link'

export default function RelayWireGuidePage() {
  const { locale } = useLocale()
  const t = locale === 'it' ? IT : EN

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto space-y-8">

      {/* Back link */}
      <Link
        href="/portal/guide"
        className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        {t.back}
      </Link>

      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center shrink-0">
          <Globe className="h-6 w-6 text-blue-600" />
        </div>
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{t.title}</h1>
          <p className="text-zinc-500 text-sm mt-0.5">{t.subtitle}</p>
        </div>
      </div>

      {/* What you need */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
        <p className="text-sm font-semibold text-amber-800 mb-3">{t.needTitle}</p>
        <ul className="space-y-2">
          {t.needItems.map((item, i) => (
            <li key={i} className="flex items-center gap-2.5 text-sm text-amber-700">
              <CheckCircle className="h-4 w-4 shrink-0" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      {/* Steps */}
      <div className="space-y-4">
        <h2 className="text-base font-semibold">{t.stepsTitle}</h2>
        {t.steps.map((step, i) => (
          <div key={i} className="bg-white rounded-xl border p-5">
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full bg-blue-600 text-white text-sm font-bold flex items-center justify-center shrink-0 mt-0.5">
                {i + 1}
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-zinc-900 mb-1">{step.title}</p>
                <p className="text-sm text-zinc-500 leading-relaxed">{step.desc}</p>
                {step.fields && (
                  <ul className="mt-3 space-y-2">
                    {step.fields.map((field, j) => (
                      <li key={j} className="flex items-start gap-2 text-sm">
                        <ChevronRight className="h-4 w-4 text-blue-400 mt-0.5 shrink-0" />
                        <span>
                          <span className="font-medium text-zinc-800">{field.name}</span>
                          {field.note && <span className="text-zinc-500"> — {field.note}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Tips */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-5">
        <div className="flex items-start gap-3">
          <Info className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-blue-800 mb-2">{t.tipsTitle}</p>
            <ul className="space-y-1.5">
              {t.tips.map((tip, i) => (
                <li key={i} className="text-sm text-blue-700 leading-relaxed">{tip}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Help */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-xl p-6 text-white text-center">
        <MessageCircle className="h-8 w-8 mx-auto mb-2 opacity-80" />
        <p className="text-sm font-semibold mb-1">{t.helpTitle}</p>
        <p className="text-xs opacity-80 mb-4">{t.helpDesc}</p>
        <Link
          href="/portal/chat"
          className="inline-flex items-center gap-2 px-4 py-2 bg-white text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-50 transition-colors"
        >
          <MessageCircle className="h-4 w-4" />
          {t.chatBtn}
        </Link>
      </div>

    </div>
  )
}

// ─── English Content ─────────────────────────────────────────

const EN = {
  back: 'Back to Guide',
  title: 'How to Send an International Wire',
  subtitle: 'Step-by-step guide for sending a SWIFT wire transfer via your Relay account.',
  needTitle: 'What you need before you start',
  needItems: [
    'Access to your Relay business bank account',
    "Recipient's SWIFT/BIC code",
    "Recipient's IBAN (account number)",
    "Recipient's full legal name or business name",
    "Recipient's full address",
    "Recipient's bank name and address",
  ],
  stepsTitle: 'Steps',
  steps: [
    {
      title: 'Log in to Relay',
      desc: 'Go to relayfi.com and sign in to your account.',
    },
    {
      title: 'Open Payments → Payees',
      desc: 'In the left sidebar, click Payments to expand the section, then click Payees.',
    },
    {
      title: 'Click "+ New Payee"',
      desc: 'Click the + New Payee button in the top right corner. A form will open. Fill in the following:',
      fields: [
        { name: 'Payee nickname', note: 'Any name to identify this contact inside Relay. Required.' },
        { name: 'Email', note: 'Optional. Add it if you want Relay to notify the recipient when a payment is sent.' },
        { name: 'Default Memo', note: 'Optional. A reason for payment that will pre-fill on every transfer to this payee.' },
      ],
    },
    {
      title: 'Set Account Classification',
      desc: 'Click the Account Classification dropdown and select Business if paying a company, or Personal if paying an individual.',
    },
    {
      title: 'Add Payment Method — International Wire (Swift Network)',
      desc: 'Scroll down to the Payment Method section, click Add A Payment Method, and select International Wire (Swift Network) from the list.',
    },
    {
      title: 'Enter Payment Details Manually',
      desc: "Select Enter payment details manually. Then fill in the recipient's banking information:",
      fields: [
        { name: 'Country', note: "The country where the recipient's bank is located." },
        { name: 'SWIFT/BIC code', note: "The international identifier for the recipient's bank (e.g. BNLIITRR)." },
        { name: 'IBAN', note: "The recipient's account number for international transfers (e.g. IT60 X054 2811 1010 0000 0123 456)." },
        { name: 'Beneficiary name', note: 'The full legal name of the person or company receiving the wire.' },
        { name: 'Beneficiary address', note: "The recipient's full street address." },
        { name: 'Bank name & address', note: "The name and address of the recipient's bank." },
      ],
    },
    {
      title: 'Click "Create Payee"',
      desc: 'Once all fields are complete, click Create Payee. The payee is saved. To send a wire, go to Payments → Send Money and select this payee.',
    },
  ],
  tipsTitle: 'Good to know',
  tips: [
    'The IBAN is the account number — it replaces a routing number for international transfers.',
    "If the recipient's country uses a local payment network instead of SWIFT, choose International Wire (Local Network).",
    'Wire fees may apply — check your Relay plan for current rates.',
    'Once created, a payee is saved permanently and does not need to be re-entered for future wires.',
  ],
  helpTitle: 'Need Help?',
  helpDesc: 'If you have questions or run into any issues, our team is here to help.',
  chatBtn: 'Chat With Us',
}

// ─── Italian Content ─────────────────────────────────────────

const IT = {
  back: 'Torna alla Guida',
  title: 'Come Inviare un Bonifico Internazionale',
  subtitle: 'Guida passo passo per inviare un bonifico SWIFT tramite il tuo conto Relay.',
  needTitle: 'Cosa ti serve prima di iniziare',
  needItems: [
    'Accesso al tuo conto business Relay',
    'Codice SWIFT/BIC del destinatario',
    'IBAN del destinatario (numero di conto)',
    'Nome legale completo o ragione sociale del destinatario',
    'Indirizzo completo del destinatario',
    'Nome e indirizzo della banca del destinatario',
  ],
  stepsTitle: 'Passaggi',
  steps: [
    {
      title: 'Accedi a Relay',
      desc: 'Vai su relayfi.com e accedi al tuo account.',
    },
    {
      title: 'Apri Payments → Payees',
      desc: 'Nel menu laterale sinistro, clicca su Payments per espandere la sezione, poi clicca su Payees.',
    },
    {
      title: 'Clicca "+ New Payee"',
      desc: 'Clicca il pulsante + New Payee in alto a destra. Si aprirà un modulo. Compila i seguenti campi:',
      fields: [
        { name: 'Payee nickname', note: 'Un nome qualsiasi per identificare questo contatto in Relay. Obbligatorio.' },
        { name: 'Email', note: 'Opzionale. Aggiungila se vuoi che Relay notifichi il destinatario quando viene inviato un pagamento.' },
        { name: 'Default Memo', note: 'Opzionale. La causale del pagamento, pre-compilata su ogni trasferimento a questo beneficiario.' },
      ],
    },
    {
      title: 'Imposta la Classificazione del Conto',
      desc: "Clicca il menu Account Classification e seleziona Business se stai pagando un'azienda, oppure Personal se stai pagando un privato.",
    },
    {
      title: 'Aggiungi il Metodo di Pagamento — Bonifico Internazionale (Rete Swift)',
      desc: "Scorri fino alla sezione Payment Method, clicca Add A Payment Method e seleziona International Wire (Swift Network) dall'elenco.",
    },
    {
      title: 'Inserisci i Dati Bancari Manualmente',
      desc: 'Seleziona Enter payment details manually. Poi compila i dati bancari del destinatario:',
      fields: [
        { name: 'Country', note: 'Il paese in cui si trova la banca del destinatario.' },
        { name: 'Codice SWIFT/BIC', note: "L'identificativo internazionale della banca del destinatario (es. BNLIITRR)." },
        { name: 'IBAN', note: 'Il numero di conto del destinatario per i trasferimenti internazionali (es. IT60 X054 2811 1010 0000 0123 456).' },
        { name: 'Nome del beneficiario', note: 'Il nome legale completo della persona o azienda che riceve il bonifico.' },
        { name: 'Indirizzo del beneficiario', note: "L'indirizzo completo del destinatario." },
        { name: 'Nome e indirizzo della banca', note: 'Il nome e indirizzo della banca del destinatario.' },
      ],
    },
    {
      title: 'Clicca "Create Payee"',
      desc: 'Una volta completati tutti i campi, clicca Create Payee. Il beneficiario è salvato. Per inviare un bonifico, vai su Payments → Send Money e seleziona questo beneficiario.',
    },
  ],
  tipsTitle: 'Da sapere',
  tips: [
    "L'IBAN è il numero di conto — sostituisce il codice di routing per i trasferimenti internazionali.",
    'Se il paese del destinatario utilizza una rete locale (non SWIFT), scegli International Wire (Local Network).',
    'Potrebbero essere applicate commissioni — controlla il tuo piano Relay per le tariffe attuali.',
    'Una volta creato, il beneficiario viene salvato in modo permanente e non deve essere reinserito per i bonifici futuri.',
  ],
  helpTitle: 'Hai Bisogno di Aiuto?',
  helpDesc: 'Se hai domande o incontri difficoltà, il nostro team è qui per aiutarti.',
  chatBtn: 'Chatta Con Noi',
}
