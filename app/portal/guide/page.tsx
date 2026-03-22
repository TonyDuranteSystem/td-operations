'use client'

import {
  LayoutDashboard, FileText, Receipt, MessageCircle, Activity,
  Bell, CreditCard, CheckCircle, ArrowRight, Package,
  Upload, CalendarDays, Shield, BookOpen, Fingerprint,
  Building2, Phone, ChevronDown,
} from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import Link from 'next/link'

export default function PortalGuidePage() {
  const { locale } = useLocale()
  const t = locale === 'it' ? IT : EN

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{t.title}</h1>
        <p className="text-zinc-500 text-sm mt-1">{t.subtitle}</p>
      </div>

      {/* How It Works — Step Timeline */}
      <div className="bg-white rounded-xl border p-6">
        <h2 className="text-base font-semibold mb-4">{t.howItWorks}</h2>
        <div className="space-y-4">
          {t.steps.map((step, i) => (
            <div key={i} className="flex gap-4">
              <div className="flex flex-col items-center">
                <div className={cn(
                  'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white',
                  i === 0 ? 'bg-blue-600' : i === 1 ? 'bg-indigo-600' : i === 2 ? 'bg-purple-600' : 'bg-green-600'
                )}>
                  {i + 1}
                </div>
                {i < t.steps.length - 1 && <div className="w-0.5 h-full bg-zinc-200 my-1" />}
              </div>
              <div className="pb-4">
                <p className="text-sm font-semibold text-zinc-900">{step.title}</p>
                <p className="text-sm text-zinc-500 mt-0.5">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Feature Guide — Collapsible Sections */}
      <div className="space-y-3">
        <h2 className="text-base font-semibold">{t.featuresTitle}</h2>

        {t.features.map((feature, i) => (
          <FeatureCard key={i} {...feature} />
        ))}
      </div>

      {/* Available Services */}
      <div className="bg-white rounded-xl border p-6">
        <h2 className="text-base font-semibold mb-4">{t.servicesTitle}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {t.services.map((svc, i) => (
            <div key={i} className="flex items-center gap-3 p-3 bg-zinc-50 rounded-lg">
              <svc.icon className={cn('h-5 w-5 shrink-0', svc.color)} />
              <div>
                <p className="text-sm font-medium">{svc.name}</p>
                <p className="text-xs text-zinc-500">{svc.desc}</p>
              </div>
            </div>
          ))}
        </div>
        <Link
          href="/portal/services/request"
          className="mt-4 flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          <Package className="h-4 w-4" />
          {t.requestBtn}
        </Link>
      </div>

      {/* FAQ */}
      <div className="space-y-3">
        <h2 className="text-base font-semibold">{t.faqTitle}</h2>
        {t.faq.map((item, i) => (
          <FaqItem key={i} question={item.q} answer={item.a} />
        ))}
      </div>

      {/* Help Banner */}
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

function FeatureCard({ icon: Icon, color, title, desc, details }: {
  icon: typeof LayoutDashboard; color: string; title: string; desc: string; details: string[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="bg-white rounded-xl border overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 p-4 hover:bg-zinc-50 transition-colors text-left"
      >
        <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0', color)}>
          <Icon className="h-4.5 w-4.5" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-zinc-900">{title}</p>
          <p className="text-xs text-zinc-500">{desc}</p>
        </div>
        <ChevronDown className={cn('h-4 w-4 text-zinc-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="px-4 pb-4 border-t pt-3">
          <ul className="space-y-2">
            {details.map((d, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-zinc-600">
                <CheckCircle className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                {d}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="bg-white rounded-xl border overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 hover:bg-zinc-50 text-left"
      >
        <p className="text-sm font-medium text-zinc-900 pr-4">{question}</p>
        <ChevronDown className={cn('h-4 w-4 text-zinc-400 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="px-4 pb-4 border-t pt-3">
          <p className="text-sm text-zinc-600 leading-relaxed">{answer}</p>
        </div>
      )}
    </div>
  )
}

// ─── English Content ─────────────────────────────────────────

const EN = {
  title: 'Portal Guide',
  subtitle: 'Everything you need to know about using your Tony Durante Portal.',
  howItWorks: 'How It Works',
  steps: [
    { title: 'Review Your Proposal', desc: 'Check the services, pricing, and terms we discussed during your consultation.' },
    { title: 'Sign & Pay', desc: 'Accept the contract and make your payment. You can pay by card or bank transfer.' },
    { title: 'Complete Your Setup', desc: 'Fill in your personal and business information through a simple step-by-step wizard.' },
    { title: 'Track Your Services', desc: 'Monitor the progress of your services, access documents, and communicate with our team.' },
  ],
  featuresTitle: 'Portal Features',
  features: [
    {
      icon: LayoutDashboard, color: 'bg-blue-50 text-blue-600',
      title: 'Dashboard', desc: 'Your home page with an overview of everything',
      details: [
        'See your current progress and next steps',
        'View the services included in your plan',
        'Quick access to proposal, chat, and service requests',
      ],
    },
    {
      icon: FileText, color: 'bg-indigo-50 text-indigo-600',
      title: 'Your Proposal', desc: 'Review, sign, and pay for your services',
      details: [
        'Read the full proposal with services and pricing',
        'Accept and sign the service agreement digitally',
        'Choose your payment method (card or bank transfer)',
        'Download the signed contract as PDF',
      ],
    },
    {
      icon: MessageCircle, color: 'bg-green-50 text-green-600',
      title: 'Chat', desc: 'Direct communication with our team',
      details: [
        'Ask questions anytime — we usually respond within a few hours',
        'Share files and documents through chat',
        'Get updates on your services',
        'Available from the moment you sign up',
      ],
    },
    {
      icon: Upload, color: 'bg-purple-50 text-purple-600',
      title: 'Documents', desc: 'All your important documents in one place',
      details: [
        'Signed contracts appear automatically',
        'Operating Agreement, Lease, EIN Letter — all accessible here',
        'Upload additional documents when needed',
        'Download any document anytime',
      ],
    },
    {
      icon: Activity, color: 'bg-amber-50 text-amber-600',
      title: 'Services', desc: 'Track the progress of your active services',
      details: [
        'See which stage each service is at',
        'Track milestones (formation, EIN, banking, etc.)',
        'Get notified when a stage is completed',
      ],
    },
    {
      icon: CreditCard, color: 'bg-rose-50 text-rose-600',
      title: 'Billing', desc: 'View invoices and payment history',
      details: [
        'See all invoices from Tony Durante LLC',
        'Track payment status (pending, paid, overdue)',
        'Download invoice PDFs',
      ],
    },
    {
      icon: CalendarDays, color: 'bg-teal-50 text-teal-600',
      title: 'Deadlines', desc: 'Never miss an important date',
      details: [
        'Annual report filing deadlines',
        'Tax return deadlines',
        'Registered agent renewal dates',
        'Color-coded: red = overdue, yellow = due soon',
      ],
    },
    {
      icon: Package, color: 'bg-orange-50 text-orange-600',
      title: 'Request a Service', desc: 'Order additional services anytime',
      details: [
        'Browse 9 service categories',
        'Describe your need and set urgency',
        'Our team creates a quote and gets back to you',
        'Available for all clients — new and existing',
      ],
    },
  ],
  servicesTitle: 'Available Services',
  services: [
    { icon: Building2, color: 'text-blue-600', name: 'LLC Formation', desc: 'Form a new US LLC' },
    { icon: Receipt, color: 'text-green-600', name: 'Tax Return', desc: 'Annual tax filing' },
    { icon: Fingerprint, color: 'text-purple-600', name: 'ITIN Application', desc: 'IRS Individual Tax ID' },
    { icon: CreditCard, color: 'text-amber-600', name: 'Business Banking', desc: 'USD or EUR account' },
    { icon: FileText, color: 'text-indigo-600', name: 'EIN Application', desc: 'Employer ID Number' },
    { icon: Package, color: 'text-orange-600', name: 'Shipping', desc: 'International shipping' },
    { icon: FileText, color: 'text-rose-600', name: 'Public Notary', desc: 'Notarization & apostille' },
    { icon: Phone, color: 'text-teal-600', name: 'Consulting', desc: 'One-on-one consultation' },
  ],
  requestBtn: 'Request a Service',
  faqTitle: 'Frequently Asked Questions',
  faq: [
    { q: 'How long does LLC formation take?', a: 'Typically 3-5 business days for New Mexico, 5-7 for Wyoming and Delaware. After formation, EIN takes an additional 2-4 weeks.' },
    { q: 'What do I need to provide?', a: 'A valid passport, proof of address, and your business details. The setup wizard will guide you through everything step by step.' },
    { q: 'How do I pay?', a: 'You can pay by credit card (processed through Whop) or bank transfer. Payment details are shown after signing the contract.' },
    { q: 'What happens after I pay?', a: 'Your portal will update to show the data collection wizard. Complete it with your information, and we start working on your services immediately.' },
    { q: 'Can I track the progress of my services?', a: 'Yes! The Services page shows real-time progress of each service with stage-by-stage tracking. You also get notifications when milestones are reached.' },
    { q: 'How do I contact support?', a: 'Use the Chat feature in the portal — it goes directly to our team. You can also email support@tonydurante.us or message us on WhatsApp.' },
  ],
  helpTitle: 'Need Help?',
  helpDesc: 'Our team is here to assist you. Send us a message and we\'ll get back to you shortly.',
  chatBtn: 'Chat With Us',
}

// ─── Italian Content ─────────────────────────────────────────

const IT = {
  title: 'Guida al Portale',
  subtitle: 'Tutto quello che devi sapere per utilizzare il tuo Portale Tony Durante.',
  howItWorks: 'Come Funziona',
  steps: [
    { title: 'Rivedi la Proposta', desc: 'Controlla i servizi, i prezzi e le condizioni discusse durante la consulenza.' },
    { title: 'Firma e Paga', desc: 'Accetta il contratto e effettua il pagamento. Puoi pagare con carta o bonifico bancario.' },
    { title: 'Completa la Registrazione', desc: 'Inserisci i tuoi dati personali e aziendali tramite una semplice procedura guidata.' },
    { title: 'Monitora i Tuoi Servizi', desc: 'Segui l\'avanzamento dei tuoi servizi, accedi ai documenti e comunica con il nostro team.' },
  ],
  featuresTitle: 'Funzionalità del Portale',
  features: [
    {
      icon: LayoutDashboard, color: 'bg-blue-50 text-blue-600',
      title: 'Dashboard', desc: 'La tua pagina principale con una panoramica di tutto',
      details: [
        'Vedi il tuo progresso attuale e i prossimi passi',
        'Visualizza i servizi inclusi nel tuo piano',
        'Accesso rapido a proposta, chat e richieste di servizio',
      ],
    },
    {
      icon: FileText, color: 'bg-indigo-50 text-indigo-600',
      title: 'La Tua Proposta', desc: 'Rivedi, firma e paga per i tuoi servizi',
      details: [
        'Leggi la proposta completa con servizi e prezzi',
        'Accetta e firma il contratto di servizio digitalmente',
        'Scegli il metodo di pagamento (carta o bonifico)',
        'Scarica il contratto firmato in PDF',
      ],
    },
    {
      icon: MessageCircle, color: 'bg-green-50 text-green-600',
      title: 'Chat', desc: 'Comunicazione diretta con il nostro team',
      details: [
        'Fai domande in qualsiasi momento — rispondiamo di solito entro poche ore',
        'Condividi file e documenti tramite chat',
        'Ricevi aggiornamenti sui tuoi servizi',
        'Disponibile dal momento della registrazione',
      ],
    },
    {
      icon: Upload, color: 'bg-purple-50 text-purple-600',
      title: 'Documenti', desc: 'Tutti i tuoi documenti importanti in un unico posto',
      details: [
        'I contratti firmati appaiono automaticamente',
        'Operating Agreement, Lease, Lettera EIN — tutto accessibile qui',
        'Carica documenti aggiuntivi quando necessario',
        'Scarica qualsiasi documento in qualsiasi momento',
      ],
    },
    {
      icon: Activity, color: 'bg-amber-50 text-amber-600',
      title: 'Servizi', desc: 'Segui l\'avanzamento dei tuoi servizi attivi',
      details: [
        'Vedi a che fase si trova ogni servizio',
        'Traccia le tappe (costituzione, EIN, banking, ecc.)',
        'Ricevi notifiche quando una fase è completata',
      ],
    },
    {
      icon: CreditCard, color: 'bg-rose-50 text-rose-600',
      title: 'Fatturazione', desc: 'Visualizza fatture e storico pagamenti',
      details: [
        'Vedi tutte le fatture di Tony Durante LLC',
        'Traccia lo stato dei pagamenti (in attesa, pagato, scaduto)',
        'Scarica le fatture in PDF',
      ],
    },
    {
      icon: CalendarDays, color: 'bg-teal-50 text-teal-600',
      title: 'Scadenze', desc: 'Non perdere mai una data importante',
      details: [
        'Scadenze per l\'Annual Report',
        'Scadenze per la dichiarazione dei redditi',
        'Date di rinnovo del Registered Agent',
        'Codice colore: rosso = scaduto, giallo = in scadenza',
      ],
    },
    {
      icon: Package, color: 'bg-orange-50 text-orange-600',
      title: 'Richiedi un Servizio', desc: 'Ordina servizi aggiuntivi in qualsiasi momento',
      details: [
        'Sfoglia 9 categorie di servizi',
        'Descrivi la tua esigenza e imposta l\'urgenza',
        'Il nostro team crea un preventivo e ti ricontatta',
        'Disponibile per tutti i clienti — nuovi ed esistenti',
      ],
    },
  ],
  servicesTitle: 'Servizi Disponibili',
  services: [
    { icon: Building2, color: 'text-blue-600', name: 'Costituzione LLC', desc: 'Crea una nuova LLC americana' },
    { icon: Receipt, color: 'text-green-600', name: 'Dichiarazione dei Redditi', desc: 'Dichiarazione fiscale annuale' },
    { icon: Fingerprint, color: 'text-purple-600', name: 'Richiesta ITIN', desc: 'Codice fiscale individuale IRS' },
    { icon: CreditCard, color: 'text-amber-600', name: 'Conto Business', desc: 'Conto USD o EUR' },
    { icon: FileText, color: 'text-indigo-600', name: 'Richiesta EIN', desc: 'Employer ID Number' },
    { icon: Package, color: 'text-orange-600', name: 'Spedizioni', desc: 'Spedizioni internazionali' },
    { icon: FileText, color: 'text-rose-600', name: 'Notaio Pubblico', desc: 'Notarizzazione e apostille' },
    { icon: Phone, color: 'text-teal-600', name: 'Consulenza', desc: 'Consulenza personalizzata' },
  ],
  requestBtn: 'Richiedi un Servizio',
  faqTitle: 'Domande Frequenti',
  faq: [
    { q: 'Quanto tempo ci vuole per la costituzione della LLC?', a: 'Tipicamente 3-5 giorni lavorativi per il New Mexico, 5-7 per Wyoming e Delaware. Dopo la costituzione, l\'EIN richiede ulteriori 2-4 settimane.' },
    { q: 'Cosa devo fornire?', a: 'Un passaporto valido, prova di residenza e i dettagli della tua attività. La procedura guidata ti accompagnerà passo dopo passo.' },
    { q: 'Come posso pagare?', a: 'Puoi pagare con carta di credito (elaborata tramite Whop) o con bonifico bancario. I dettagli del pagamento vengono mostrati dopo la firma del contratto.' },
    { q: 'Cosa succede dopo il pagamento?', a: 'Il tuo portale si aggiornerà per mostrare la procedura guidata per la raccolta dati. Completala con le tue informazioni e inizieremo a lavorare immediatamente.' },
    { q: 'Posso monitorare l\'avanzamento dei miei servizi?', a: 'Sì! La pagina Servizi mostra l\'avanzamento in tempo reale di ogni servizio con tracciamento fase per fase. Ricevi anche notifiche quando le tappe vengono raggiunte.' },
    { q: 'Come contatto l\'assistenza?', a: 'Usa la funzione Chat nel portale — va direttamente al nostro team. Puoi anche scrivere a support@tonydurante.us o inviarci un messaggio su WhatsApp.' },
  ],
  helpTitle: 'Hai Bisogno di Aiuto?',
  helpDesc: 'Il nostro team è qui per assisterti. Inviaci un messaggio e ti risponderemo a breve.',
  chatBtn: 'Chatta Con Noi',
}
