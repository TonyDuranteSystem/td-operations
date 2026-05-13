'use client'

import {
  MessageCircle, Package, LayoutDashboard, Building2, CalendarDays,
  FileText, PenLine, ScrollText, Users, Receipt, Bookmark, Building,
  CreditCard, User, ImageIcon, Landmark, Link2, Globe, Lock,
  Gift, ChevronDown, Search, X, ArrowRight,
} from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'
import { useState, useMemo } from 'react'
import { cn } from '@/lib/utils'
import Link from 'next/link'

// ─── Types ───────────────────────────────────────────────────

interface Step {
  text: string
  sub?: string
}

interface Article {
  id: string
  section: string
  icon: typeof MessageCircle
  iconBg: string
  iconColor: string
  title: string
  desc: string
  keywords: string[]
  steps: Step[]
  link?: { href: string; label: string }
}

interface Content {
  pageTitle: string
  pageSubtitle: string
  searchPlaceholder: string
  searchNoResults: string
  searchResultCount: (n: number) => string
  sections: string[]
  articles: Article[]
  helpTitle: string
  helpDesc: string
  chatBtn: string
}

// ─── Article Component ────────────────────────────────────────

function ArticleCard({ article, defaultOpen }: { article: Article; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false)

  return (
    <div className="bg-white rounded-xl border overflow-hidden shadow-sm">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 p-4 hover:bg-zinc-50 transition-colors text-left"
      >
        <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0', article.iconBg)}>
          <article.icon className={cn('h-4 w-4', article.iconColor)} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-zinc-900">{article.title}</p>
          <p className="text-xs text-zinc-500 mt-0.5 truncate">{article.desc}</p>
        </div>
        <ChevronDown className={cn('h-4 w-4 text-zinc-400 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="border-t px-4 pb-4 pt-3 space-y-3">
          <ol className="space-y-2">
            {article.steps.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                  {i + 1}
                </span>
                <div>
                  <p className="text-sm text-zinc-700">{step.text}</p>
                  {step.sub && <p className="text-xs text-zinc-400 mt-0.5">{step.sub}</p>}
                </div>
              </li>
            ))}
          </ol>
          {article.link && (
            <Link
              href={article.link.href}
              className="inline-flex items-center gap-1.5 text-xs text-blue-600 font-medium hover:text-blue-700 mt-2"
            >
              <ArrowRight className="h-3.5 w-3.5" />
              {article.link.label}
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Search Bar ───────────────────────────────────────────────

function SearchBar({ value, onChange, placeholder }: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-9 pr-10 py-3 text-sm bg-white border rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
      {value && (
        <button
          onClick={() => onChange('')}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-zinc-100"
        >
          <X className="h-4 w-4 text-zinc-400" />
        </button>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────

export default function PortalGuidePage() {
  const { locale } = useLocale()
  const content: Content = locale === 'it' ? IT : EN
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    if (!query.trim()) return null
    const q = query.toLowerCase()
    return content.articles.filter(a =>
      a.title.toLowerCase().includes(q) ||
      a.desc.toLowerCase().includes(q) ||
      a.keywords.some(k => k.toLowerCase().includes(q)) ||
      a.steps.some(s => s.text.toLowerCase().includes(q))
    )
  }, [query, content.articles])

  const groupedArticles = useMemo(() => {
    const groups: Record<string, Article[]> = {}
    for (const a of content.articles) {
      if (!groups[a.section]) groups[a.section] = []
      groups[a.section].push(a)
    }
    return groups
  }, [content.articles])

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{content.pageTitle}</h1>
        <p className="text-zinc-500 text-sm mt-1">{content.pageSubtitle}</p>
      </div>

      {/* Search */}
      <SearchBar
        value={query}
        onChange={setQuery}
        placeholder={content.searchPlaceholder}
      />

      {/* Search results */}
      {filtered !== null && (
        <div className="space-y-3">
          {filtered.length > 0 ? (
            <>
              <p className="text-xs text-zinc-500">{content.searchResultCount(filtered.length)}</p>
              {filtered.map(a => <ArticleCard key={a.id} article={a} defaultOpen />)}
            </>
          ) : (
            <div className="bg-white rounded-xl border p-8 text-center">
              <Search className="h-8 w-8 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">{content.searchNoResults}</p>
            </div>
          )}
        </div>
      )}

      {/* Grouped sections (when not searching) */}
      {filtered === null && (
        <>
          {content.sections.map(section => {
            const articles = groupedArticles[section]
            if (!articles?.length) return null
            return (
              <div key={section} className="space-y-2">
                <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider px-1">{section}</h2>
                {articles.map(a => <ArticleCard key={a.id} article={a} />)}
              </div>
            )
          })}

          {/* Guides section */}
          <div className="space-y-2">
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider px-1">
              {locale === 'it' ? 'Guide Pratiche' : 'Step-by-Step Guides'}
            </h2>
            {[
              {
                href: '/portal/guide/relay-wire',
                icon: Globe,
                color: 'bg-blue-50',
                iconColor: 'text-blue-600',
                title: locale === 'it' ? 'Come Inviare un Bonifico Internazionale' : 'How to Send an International Wire',
                desc: locale === 'it'
                  ? 'Guida passo passo per inviare un bonifico SWIFT tramite il tuo conto Relay.'
                  : 'Step-by-step guide for sending a SWIFT transfer via your Relay account.',
              },
              {
                href: '/portal/guide/relay-docs',
                icon: FileText,
                color: 'bg-blue-50',
                iconColor: 'text-blue-600',
                title: locale === 'it' ? 'Relay — Sblocco Bonifici Internazionali' : 'Relay — Unlock International Payments',
                desc: locale === 'it'
                  ? 'Cosa caricare per sbloccare i bonifici internazionali sul tuo conto Relay.'
                  : 'What documents to upload to unlock international wire transfers on Relay.',
              },
            ].map(g => (
              <Link
                key={g.href}
                href={g.href}
                className="flex items-center gap-3 bg-white rounded-xl border shadow-sm p-4 hover:bg-zinc-50 transition-colors"
              >
                <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0', g.color)}>
                  <g.icon className={cn('h-4 w-4', g.iconColor)} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-zinc-900">{g.title}</p>
                  <p className="text-xs text-zinc-500 mt-0.5">{g.desc}</p>
                </div>
                <ArrowRight className="h-4 w-4 text-zinc-400 shrink-0" />
              </Link>
            ))}
          </div>

          {/* Help Banner */}
          <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-xl p-6 text-white text-center">
            <MessageCircle className="h-8 w-8 mx-auto mb-2 opacity-80" />
            <p className="text-sm font-semibold mb-1">{content.helpTitle}</p>
            <p className="text-xs opacity-80 mb-4">{content.helpDesc}</p>
            <Link
              href="/portal/chat"
              className="inline-flex items-center gap-2 px-4 py-2 bg-white text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-50 transition-colors"
            >
              <MessageCircle className="h-4 w-4" />
              {content.chatBtn}
            </Link>
          </div>
        </>
      )}
    </div>
  )
}

// ─── ENGLISH CONTENT ──────────────────────────────────────────

const SECTIONS_EN = [
  'Communication',
  'Your Company',
  'Documents',
  'Finance & Invoicing',
  'Profile',
  'Referrals',
]

const ARTICLES_EN: Article[] = [
  // ── Communication ──
  {
    id: 'chat',
    section: 'Communication',
    icon: MessageCircle,
    iconBg: 'bg-green-50',
    iconColor: 'text-green-600',
    title: 'Chat',
    desc: 'Send messages and files to our team',
    keywords: ['chat', 'message', 'contact', 'support', 'talk', 'team', 'help', 'file', 'upload', 'voice', 'attachment', 'topic', 'thread', 'reply', 'messaggio', 'comunicazione', 'parlare'],
    steps: [
      { text: 'Click "Chat" in the left menu to open your conversation with our team.' },
      { text: 'Type your message in the input box at the bottom and press Enter to send.', sub: 'Use Shift+Enter to add a new line without sending.' },
      { text: 'Attach files by clicking the paperclip icon or dragging and dropping files.', sub: 'Accepted: PDF, JPG, PNG, Word, Excel, TXT. Max 10 MB per file, up to 5 files at once.' },
      { text: 'Use the microphone icon to record a voice note.', sub: 'The browser will ask for permission the first time.' },
      { text: 'Create a new topic using the "+" button next to the topic list.', sub: 'Topics help organise conversations (e.g. "Banking", "Tax Return").' },
      { text: 'Reply to a specific message by hovering over it and clicking the reply icon.', sub: 'This creates a thread so the context stays clear.' },
      { text: 'Blue double-checkmarks (✓✓) mean your message has been read by our team.' },
    ],
    link: { href: '/portal/chat', label: 'Go to Chat' },
  },
  {
    id: 'request-service',
    section: 'Communication',
    icon: Package,
    iconBg: 'bg-orange-50',
    iconColor: 'text-orange-600',
    title: 'Request a New Service',
    desc: 'Order a new service from our team',
    keywords: ['service', 'request', 'order', 'new', 'llc', 'tax', 'itin', 'banking', 'relay', 'ein', 'shipping', 'notary', 'consulting', 'formation', 'servizio', 'richiesta', 'ordine', 'conto', 'banca'],
    steps: [
      { text: 'Click "Request Service" in the left menu.' },
      { text: 'Choose the service category that fits your need:', sub: 'LLC Formation · Tax Return · ITIN · Banking (Relay USD or Payset EUR) · EIN · Shipping · Notary/Apostille · Company Closure · Consulting' },
      { text: 'Describe what you need in the text box. Be as specific as possible.', sub: 'Example: "I need to open a Relay USD account for my Wyoming LLC".' },
      { text: 'Select urgency: Normal or Urgent.' },
      { text: 'Click Submit. Our team receives the request as a task and will respond in chat with a quote or next steps.' },
    ],
    link: { href: '/portal/services/request', label: 'Request a Service' },
  },

  // ── Your Company ──
  {
    id: 'dashboard',
    section: 'Your Company',
    icon: LayoutDashboard,
    iconBg: 'bg-blue-50',
    iconColor: 'text-blue-600',
    title: 'Dashboard (Home)',
    desc: 'Your portal home page',
    keywords: ['dashboard', 'home', 'overview', 'start', 'main', 'status', 'progress', 'panoramica', 'inizio', 'home'],
    steps: [
      { text: 'The dashboard is the first page you see when you log in. What it shows depends on where you are in the process:' },
      { text: 'If your services are not yet confirmed: you will see your proposal card to review and sign.' },
      { text: 'If payment is confirmed but setup is in progress: you will see the data collection wizard showing your completion percentage.' },
      { text: 'If your company is active: you will see a summary of your active services, recent activity, and upcoming deadlines.' },
      { text: 'Use the left sidebar to navigate between all portal sections at any time.' },
    ],
  },
  {
    id: 'my-company',
    section: 'Your Company',
    icon: Building2,
    iconBg: 'bg-indigo-50',
    iconColor: 'text-indigo-600',
    title: 'My Company',
    desc: 'Company information, services, and deadlines at a glance',
    keywords: ['company', 'azienda', 'llc', 'ein', 'state', 'formation', 'registered agent', 'entity', 'info', 'details', 'stato', 'costituzione', 'informazioni', 'agenzia'],
    steps: [
      { text: 'Click "My Company" in the left menu to see your company snapshot.' },
      { text: 'The Company Info card shows: legal name, entity type (LLC/C-Corp), EIN, state of formation, formation date, and registered agent.' },
      { text: 'Below that, Upcoming Deadlines lists your next 5 compliance deadlines with their status and due date.', sub: 'Click "View All" to open the full Deadlines calendar.' },
      { text: 'Active Services shows each service currently in progress with its current stage (e.g. "Formation", "EIN Pending").' },
      { text: 'Completed Services shows all services that have been successfully delivered.' },
    ],
    link: { href: '/portal/company', label: 'Go to My Company' },
  },
  {
    id: 'deadlines',
    section: 'Your Company',
    icon: CalendarDays,
    iconBg: 'bg-teal-50',
    iconColor: 'text-teal-600',
    title: 'Deadlines',
    desc: 'Calendar of compliance and filing deadlines',
    keywords: ['deadline', 'calendar', 'due date', 'annual report', 'tax', 'scadenza', 'calendario', 'filing', 'compliance', 'report', 'rinnovo', 'annual', 'overdue', 'pending'],
    steps: [
      { text: 'Click "Deadlines" in the left menu to open the deadline tracker.' },
      { text: 'At the top: three summary tiles show your Total, Pending, and Overdue deadline counts.' },
      { text: 'Toggle between Calendar view (monthly grid) and List view (sorted by due date) using the buttons at the top right.' },
      { text: 'In Calendar view: coloured dots appear on dates with deadlines. Click any date to see the full details.', sub: 'Amber dot = Pending · Red dot = Overdue · Green dot = Filed/Completed' },
      { text: 'In List view: each pending deadline shows the deadline type, due date, state, and how many days remain (or how overdue it is).' },
      { text: 'When a deadline is filed, our team marks it as "Filed" and it turns green. You do not need to do this yourself.' },
    ],
    link: { href: '/portal/deadlines', label: 'Go to Deadlines' },
  },

  // ── Documents ──
  {
    id: 'documents',
    section: 'Documents',
    icon: FileText,
    iconBg: 'bg-purple-50',
    iconColor: 'text-purple-600',
    title: 'Documents',
    desc: 'Browse, preview, and download your company documents',
    keywords: ['document', 'file', 'download', 'pdf', 'contract', 'certificate', 'operating agreement', 'oa', 'lease', 'passport', 'upload', 'documenti', 'scarica', 'contratto', 'certificato', 'carica', 'file'],
    steps: [
      { text: 'Click "Documents" in the left menu to see all documents associated with your account.' },
      { text: 'Use the search bar at the top to find a document by file name or type (e.g. "Operating Agreement", "EIN Letter").' },
      { text: 'Use the category filter buttons to narrow results by type (Contracts, Formation, Tax, Other).' },
      { text: 'Click the eye icon (👁) to preview a document directly in the browser — works for PDF and image files.' },
      { text: 'Click the download icon (⬇) to save the file to your device.' },
      { text: 'To upload a document: click the "Upload Document" button at the top right, select a file, and choose the document type.', sub: 'Use this to share passports, utility bills, or any document our team has requested.' },
    ],
    link: { href: '/portal/documents', label: 'Go to Documents' },
  },
  {
    id: 'sign-documents',
    section: 'Documents',
    icon: PenLine,
    iconBg: 'bg-amber-50',
    iconColor: 'text-amber-600',
    title: 'Sign Documents',
    desc: 'Sign your LLC contracts and agreements',
    keywords: ['sign', 'signature', 'operating agreement', 'oa', 'lease', 'ss4', 'msa', 'form 8832', 'contract', 'firmare', 'firma', 'contratto', 'accordo', 'documenti da firmare'],
    steps: [
      { text: 'Click "Sign Documents" in the left menu. This section only appears when you have documents waiting for your signature.' },
      { text: 'You will see a list of documents with a progress bar at the top showing how many you have signed vs how many remain.' },
      { text: 'The document types that may appear here include:', sub: 'Operating Agreement (OA) · Office Lease · SS-4 EIN Application · Annual Service Agreement · Form 8832 (C-Corp Election)' },
      { text: 'Click any card with a blue "pen" icon to open the signing page for that document.' },
      { text: 'Read the document, then sign in the signature pad (draw your signature with your mouse or touchscreen).' },
      { text: 'Click "Confirm Signature" to finalise. The card turns green and shows the date you signed.' },
      { text: 'Once all cards are green, a party icon confirms all documents have been signed.' },
    ],
    link: { href: '/portal/sign', label: 'Go to Sign Documents' },
  },
  {
    id: 'generate-documents',
    section: 'Documents',
    icon: ScrollText,
    iconBg: 'bg-violet-50',
    iconColor: 'text-violet-600',
    title: 'Generate Documents',
    desc: 'Create distribution resolutions, tax statements, and operating agreements',
    keywords: ['generate', 'create', 'distribution', 'resolution', 'verbale', 'tax statement', 'certificato fiscale', 'operating agreement', 'atto', 'profit', 'utili', 'distribuzione', 'documento', 'genera'],
    steps: [
      { text: 'Click "Generate Documents" in the left menu.' },
      { text: 'Select the document type you want to create:', sub: 'Distribution Resolution — formal authorisation to distribute profits to LLC members\nTax Statement — certificate of distribution for foreign tax authorities\nOperating Agreement — founding document of your LLC (regenerate with updated information)' },
      { text: 'Fill in the required fields. For Distribution Resolution and Tax Statement: enter the amount, fiscal year, distribution date, and currency (USD or EUR). For Operating Agreement: enter the effective date and member addresses.' },
      { text: 'Click "Preview" to see how the document will look. Company data (EIN, state, members) is filled in automatically.' },
      { text: 'Choose "Download PDF" to save without signing, or "Sign & Download" to add your signature to the document.' },
      { text: 'For "Sign & Download": draw your signature in the pad that appears, then click "Confirm & Download". The signed PDF is saved to your device.' },
      { text: 'All generated documents are logged in the History table at the bottom of the page.' },
    ],
    link: { href: '/portal/documents/generate', label: 'Go to Generate Documents' },
  },

  // ── Finance & Invoicing ──
  {
    id: 'create-invoice',
    section: 'Finance & Invoicing',
    icon: Receipt,
    iconBg: 'bg-emerald-50',
    iconColor: 'text-emerald-600',
    title: 'Creating a Sales Invoice',
    desc: 'Issue an invoice to one of your clients',
    keywords: ['invoice', 'fattura', 'create', 'new invoice', 'sales', 'bill', 'client', 'customer', 'line item', 'amount', 'total', 'due date', 'currency', 'usd', 'eur', 'discount', 'emettere fattura', 'nuova fattura'],
    steps: [
      { text: 'Go to Invoices → Sales tab, then click "New Invoice" at the top right.' },
      { text: 'Select a customer from the dropdown, or click "New Customer" to create one inline (name + email are enough).' },
      { text: 'Choose the currency (USD or EUR) and set the issue date and due date.' },
      { text: 'To use a template: select one from the "From Template" dropdown — it will pre-fill the line items and message.' },
      { text: 'Add line items: description, quantity, and unit price. The amount is calculated automatically. Add more lines with the "+ Add item" button.' },
      { text: 'Optionally: enter a discount amount, a message to the client, and internal notes (not shown on the invoice).' },
      { text: 'Select which bank account to show on the invoice (the default is pre-selected based on your profile settings).' },
      { text: 'Set the recurrence if this invoice repeats: Monthly, Quarterly, or Yearly, with an optional end date.' },
      { text: 'Click "Create Invoice". You will be redirected to the invoice detail page where you can view and send it.' },
    ],
    link: { href: '/portal/invoices/new', label: 'Create an Invoice' },
  },
  {
    id: 'invoice-templates',
    section: 'Finance & Invoicing',
    icon: Bookmark,
    iconBg: 'bg-sky-50',
    iconColor: 'text-sky-600',
    title: 'Invoice Templates',
    desc: 'Save and reuse invoice formats for repeat clients',
    keywords: ['template', 'modello', 'save', 'reuse', 'recurring', 'preset', 'fattura predefinita', 'salva', 'riutilizza'],
    steps: [
      { text: 'Go to Invoices → Sales tab. Below the invoice list, click "Templates" to expand the template panel.' },
      { text: 'To save a new template: create an invoice as normal, and at the bottom of the new invoice form, look for "Save as Template". Enter a template name and save.' },
      { text: 'Next time you create an invoice: select your template from the "From Template" dropdown at the top of the form — it will fill in the line items, currency, and message automatically.' },
      { text: 'To delete a template: expand the Templates panel on the Invoices page and click the trash icon next to the template.' },
    ],
  },
  {
    id: 'customers',
    section: 'Finance & Invoicing',
    icon: Users,
    iconBg: 'bg-blue-50',
    iconColor: 'text-blue-600',
    title: 'My Clients (Customer Directory)',
    desc: 'Add and manage your client list for invoicing',
    keywords: ['customer', 'client', 'clienti', 'directory', 'contacts', 'new customer', 'add client', 'vat', 'p.iva', 'nome cliente', 'aggiungi cliente', 'rubrica clienti'],
    steps: [
      { text: 'Click "My Clients" in the left menu.' },
      { text: 'To add a new client: click "New Customer" at the top right.' },
      { text: 'Fill in the customer details:', sub: 'First Name, Last Name, Company Name · Email · Phone · Address (street, city, state/region, country) · VAT / Tax ID · Notes' },
      { text: 'Click "Create Customer". The client now appears in the list and is available in the customer dropdown when creating invoices.' },
      { text: 'Click any customer in the list to see their invoices and payment history.' },
      { text: 'You can also add a new customer inline when creating an invoice — click "New Customer" in the customer field without leaving the invoice form.' },
    ],
    link: { href: '/portal/customers', label: 'Go to My Clients' },
  },
  {
    id: 'vendors',
    section: 'Finance & Invoicing',
    icon: Building,
    iconBg: 'bg-slate-50',
    iconColor: 'text-slate-600',
    title: 'Vendors (Supplier Directory)',
    desc: 'Track your suppliers for expense management',
    keywords: ['vendor', 'supplier', 'fornitore', 'expense', 'spesa', 'vat', 'p.iva', 'company', 'contact', 'directory', 'rubrica fornitori', 'aggiungi fornitore'],
    steps: [
      { text: 'Go to Invoices → Vendors tab.' },
      { text: 'Click "New Vendor" to add a supplier.' },
      { text: 'Fill in the vendor details:', sub: 'Company Name (required) · Contact Person · Email · Phone · VAT / Tax ID · Address · Notes' },
      { text: 'Click "Create". The vendor card appears in the grid.' },
      { text: 'To edit a vendor: click the pencil icon on their card. To delete: click the trash icon.' },
      { text: 'Vendors help you organise your expenses. You can tag expenses against a vendor to keep records clean.' },
    ],
    link: { href: '/portal/invoices?tab=vendors', label: 'Go to Vendors' },
  },
  {
    id: 'td-billing',
    section: 'Finance & Invoicing',
    icon: CreditCard,
    iconBg: 'bg-rose-50',
    iconColor: 'text-rose-600',
    title: 'TD Billing (Your Invoices from Us)',
    desc: 'View and pay Tony Durante\'s invoices to you',
    keywords: ['billing', 'td invoice', 'fattura tony durante', 'pay', 'payment', 'expenses', 'spese', 'pagamento', 'fattura td', 'invoice from us', 'pagare', 'pay button', 'stripe'],
    steps: [
      { text: 'Click "TD Billing" in the left menu. This opens the Invoices page on the Expenses tab.' },
      { text: 'Here you see all invoices issued by Tony Durante LLC to you, plus any expenses you have uploaded manually.' },
      { text: 'The summary at the top shows: Total, Paid, and Pending amounts.' },
      { text: 'To pay an open invoice: click on it, then click the "Pay Now" button. You will be taken to the secure payment page.', sub: 'You can pay by card or via the payment method shown.' },
      { text: 'Paid invoices show a green "Paid" badge and the payment date.' },
      { text: 'You can download the PDF of any invoice using the download icon on the right.' },
    ],
    link: { href: '/portal/billing', label: 'Go to TD Billing' },
  },

  // ── Profile ──
  {
    id: 'edit-profile',
    section: 'Profile',
    icon: User,
    iconBg: 'bg-zinc-100',
    iconColor: 'text-zinc-600',
    title: 'Edit Personal Information',
    desc: 'Update your name, phone, address, and citizenship',
    keywords: ['profile', 'personal info', 'name', 'phone', 'address', 'citizenship', 'language', 'edit', 'profilo', 'dati personali', 'modifica', 'nome', 'telefono', 'indirizzo', 'cittadinanza'],
    steps: [
      { text: 'Click "Profile" in the left menu.' },
      { text: 'Under "Personal Information", click the "Edit" link (pen icon at the bottom of the section).' },
      { text: 'Update any of the following fields:', sub: 'First Name · Last Name · Phone · Language preference · Citizenship · Address · City · State/Province · ZIP · Country' },
      { text: 'Email address is read-only and cannot be changed here.', sub: 'Contact our team via chat if you need to update your login email.' },
      { text: 'Click "Save" when done. Your changes are saved immediately.' },
    ],
    link: { href: '/portal/profile', label: 'Go to Profile' },
  },
  {
    id: 'logo',
    section: 'Profile',
    icon: ImageIcon,
    iconBg: 'bg-pink-50',
    iconColor: 'text-pink-600',
    title: 'Upload Your Company Logo',
    desc: 'Add a logo that appears on your invoices',
    keywords: ['logo', 'image', 'brand', 'invoice logo', 'upload logo', 'immagine', 'carica logo', 'logo fattura', 'brand', 'company logo'],
    steps: [
      { text: 'Click "Profile" in the left menu and scroll down to the "Invoice Logo" section.' },
      { text: 'Click the dashed upload area or the "Upload" button to open your file picker.' },
      { text: 'Select your logo file. Accepted formats: JPEG, PNG, WEBP, SVG. Maximum size: 2 MB.' },
      { text: 'A preview appears immediately after uploading. Your logo is saved automatically.' },
      { text: 'Your logo will now appear in the top-left corner of every invoice you create.' },
      { text: 'To change it: click "Change" next to the current logo and upload a new file.' },
    ],
    link: { href: '/portal/profile', label: 'Go to Profile' },
  },
  {
    id: 'bank-accounts',
    section: 'Profile',
    icon: Landmark,
    iconBg: 'bg-green-50',
    iconColor: 'text-green-600',
    title: 'Bank Accounts',
    desc: 'Add your bank details so clients know where to send payment',
    keywords: ['bank account', 'conto bancario', 'iban', 'routing number', 'account number', 'swift', 'bic', 'relay', 'usd', 'eur', 'add bank', 'invoice bank', 'payment details', 'conto', 'banca', 'bonifico', 'coordinate bancarie'],
    steps: [
      { text: 'Click "Profile" in the left menu and scroll down to "Bank Accounts".' },
      { text: 'Click "Add Account". Choose the currency: USD or EUR.' },
      { text: 'For USD accounts, fill in:', sub: 'Label (e.g. "Relay USD") · Account Holder Name · Bank Name · Account Number · Routing Number · SWIFT/BIC (optional) · Notes' },
      { text: 'For EUR accounts, fill in:', sub: 'Label (e.g. "Wise EUR") · Account Holder Name · Bank Name · IBAN · SWIFT/BIC · Notes' },
      { text: 'Toggle "Show on invoice" to make this account\'s details appear at the bottom of your invoices.', sub: 'Only one account can be active for invoices at a time. Switching to a new one deactivates the previous.' },
      { text: 'Click "Save". The account is now visible in your profile and auto-selected when you create invoices.' },
      { text: 'To delete an account: click the trash icon on the account card.' },
    ],
    link: { href: '/portal/profile', label: 'Go to Profile' },
  },
  {
    id: 'payment-links',
    section: 'Profile',
    icon: Link2,
    iconBg: 'bg-amber-50',
    iconColor: 'text-amber-600',
    title: 'Payment Links',
    desc: 'Add Stripe, PayPal, or Whop links so clients can pay your invoices online',
    keywords: ['payment link', 'stripe', 'paypal', 'whop', 'pay now', 'pay button', 'link pagamento', 'pagamento online', 'checkout', 'card payment', 'pagamento carta'],
    steps: [
      { text: 'Click "Profile" in the left menu and scroll down to "Payment Links".' },
      { text: 'Click "Add Payment Link".' },
      { text: 'Fill in the fields:', sub: 'Label* (e.g. "Pay with Stripe") · URL* (your payment page link) · Gateway (Stripe / PayPal / Whop / Other) · Amount (optional) · Currency (USD or EUR)' },
      { text: 'Click Save. The link now appears on your invoices as a "Pay Now" button.' },
      { text: 'The star icon sets a link as default. Click it to choose which link appears first.' },
      { text: 'Use the external link icon (↗) to test the payment URL in a new tab.' },
      { text: 'We recommend Whop for seamless checkout. If you don\'t have a Whop page yet, ask us via chat and we can help you set one up.' },
    ],
    link: { href: '/portal/profile', label: 'Go to Profile' },
  },
  {
    id: 'settings',
    section: 'Profile',
    icon: Lock,
    iconBg: 'bg-zinc-100',
    iconColor: 'text-zinc-500',
    title: 'Settings: Password, Language & Notifications',
    desc: 'Change your password, switch language, or enable push notifications',
    keywords: ['settings', 'password', 'language', 'english', 'italian', 'italiano', 'notification', 'push', 'impostazioni', 'password', 'lingua', 'notifiche', 'change password', 'cambia password', 'lingua portale'],
    steps: [
      { text: 'Click "Profile" in the left menu, then click "Settings" (or click the gear icon at the top right of the Profile page).' },
      { text: 'Language: click "English" or "Italiano" to switch the portal language. The change takes effect immediately.', sub: 'Your language preference is also saved so it applies every time you log in.' },
      { text: 'Password: enter your new password (minimum 8 characters), confirm it, then click "Update Password".' },
      { text: 'Push Notifications: click the toggle to enable browser notifications for new chat messages, deadlines, and documents.', sub: 'Your browser will ask for permission the first time.' },
    ],
    link: { href: '/portal/settings', label: 'Go to Settings' },
  },

  // ── Referrals ──
  {
    id: 'referrals',
    section: 'Referrals',
    icon: Gift,
    iconBg: 'bg-rose-50',
    iconColor: 'text-rose-600',
    title: 'Referral Program',
    desc: 'Share your link and earn a commission for each new client',
    keywords: ['referral', 'refer', 'commission', 'earn', 'friend', 'invite', 'link', 'payout', 'guadagno', 'commissione', 'referral link', 'link affiliazione', 'porta un amico', 'guadagna'],
    steps: [
      { text: 'Click "Referrals" in the left menu.' },
      { text: 'Your unique referral link is shown at the top. Click "Copy Link" to copy it to your clipboard.', sub: 'Share this link with friends, colleagues, or on social media.' },
      { text: 'When someone signs up and pays using your link, they appear in your referral list with status "Pending" → "Converted" → "Credited".' },
      { text: 'Status meanings:', sub: 'Pending (yellow) = signed up, not yet paid · Converted (blue) = paid, commission confirmed · Credited (green) = commission added to your balance · Paid (emerald) = commission transferred to you' },
      { text: 'The Payouts section at the bottom shows your payment history — amount and payment method.' },
      { text: 'If you have questions about your commission balance or want to request a payout, contact us via chat.' },
    ],
    link: { href: '/portal/referrals', label: 'Go to Referrals' },
  },
]

const EN: Content = {
  pageTitle: 'Portal Guide',
  pageSubtitle: 'Search for any feature, or browse by section. Type "logo", "invoice", "Relay", "bank" — we\'ve got it covered.',
  searchPlaceholder: 'Search: logo, invoice, Relay, bank account, signature…',
  searchNoResults: 'No results found. Try different keywords, or contact us via chat.',
  searchResultCount: (n) => `${n} result${n === 1 ? '' : 's'} found`,
  sections: SECTIONS_EN,
  articles: ARTICLES_EN,
  helpTitle: 'Still have questions?',
  helpDesc: 'Our team is available to help. Send us a message and we\'ll get back to you shortly.',
  chatBtn: 'Chat With Us',
}

// ─── ITALIAN CONTENT ──────────────────────────────────────────

const SECTIONS_IT = [
  'Comunicazione',
  'La Tua Azienda',
  'Documenti',
  'Finanza e Fatturazione',
  'Profilo',
  'Referral',
]

const ARTICLES_IT: Article[] = [
  // ── Comunicazione ──
  {
    id: 'chat',
    section: 'Comunicazione',
    icon: MessageCircle,
    iconBg: 'bg-green-50',
    iconColor: 'text-green-600',
    title: 'Chat',
    desc: 'Invia messaggi e file al nostro team',
    keywords: ['chat', 'messaggio', 'contatto', 'supporto', 'parlare', 'team', 'aiuto', 'file', 'carica', 'voce', 'allegato', 'argomento', 'risposta', 'topic', 'thread', 'reply', 'message', 'upload'],
    steps: [
      { text: 'Clicca "Chat" nel menu a sinistra per aprire la conversazione con il nostro team.' },
      { text: 'Scrivi il messaggio nel box in basso e premi Invio per inviare.', sub: 'Usa Shift+Invio per andare a capo senza inviare.' },
      { text: 'Allega file cliccando l\'icona graffetta o trascinandoli nella chat.', sub: 'Formati accettati: PDF, JPG, PNG, Word, Excel, TXT. Max 10 MB per file, fino a 5 file contemporaneamente.' },
      { text: 'Usa l\'icona microfono per registrare una nota vocale.', sub: 'Il browser chiederà il permesso la prima volta.' },
      { text: 'Crea un nuovo argomento cliccando il pulsante "+" accanto alla lista argomenti.', sub: 'Gli argomenti aiutano a organizzare le conversazioni (es. "Banking", "Dichiarazione dei Redditi").' },
      { text: 'Rispondi a un messaggio specifico passandoci sopra con il mouse e cliccando l\'icona risposta.', sub: 'Questo crea un thread per mantenere il contesto chiaro.' },
      { text: 'Il doppio segno di spunta blu (✓✓) significa che il tuo messaggio è stato letto dal nostro team.' },
    ],
    link: { href: '/portal/chat', label: 'Vai alla Chat' },
  },
  {
    id: 'request-service',
    section: 'Comunicazione',
    icon: Package,
    iconBg: 'bg-orange-50',
    iconColor: 'text-orange-600',
    title: 'Richiedi un Nuovo Servizio',
    desc: 'Ordina un nuovo servizio dal nostro team',
    keywords: ['servizio', 'richiesta', 'ordine', 'nuovo', 'llc', 'tasse', 'itin', 'banking', 'relay', 'ein', 'spedizione', 'notaio', 'consulenza', 'costituzione', 'conto', 'banca', 'service', 'request'],
    steps: [
      { text: 'Clicca "Richiedi Servizio" nel menu a sinistra.' },
      { text: 'Scegli la categoria di servizio che ti serve:', sub: 'Costituzione LLC · Dichiarazione dei Redditi · ITIN · Banking (Relay USD o Payset EUR) · EIN · Spedizioni · Notaio/Apostille · Chiusura Società · Consulenza' },
      { text: 'Descrivi nel box di testo cosa hai bisogno. Sii il più specifico possibile.', sub: 'Esempio: "Ho bisogno di aprire un conto Relay USD per la mia LLC Wyoming".' },
      { text: 'Seleziona l\'urgenza: Normale o Urgente.' },
      { text: 'Clicca Invia. Il nostro team riceve la richiesta come task e risponderà in chat con un preventivo o i passi successivi.' },
    ],
    link: { href: '/portal/services/request', label: 'Richiedi un Servizio' },
  },

  // ── La Tua Azienda ──
  {
    id: 'dashboard',
    section: 'La Tua Azienda',
    icon: LayoutDashboard,
    iconBg: 'bg-blue-50',
    iconColor: 'text-blue-600',
    title: 'Dashboard (Home)',
    desc: 'La tua pagina principale del portale',
    keywords: ['dashboard', 'home', 'panoramica', 'inizio', 'principale', 'stato', 'progresso', 'overview', 'start'],
    steps: [
      { text: 'La dashboard è la prima pagina che vedi quando accedi. Cosa mostra dipende da dove sei nel processo:' },
      { text: 'Se i tuoi servizi non sono ancora confermati: vedrai la card della proposta da rivedere e firmare.' },
      { text: 'Se il pagamento è confermato ma la configurazione è in corso: vedrai il wizard di raccolta dati con la percentuale di completamento.' },
      { text: 'Se la tua azienda è attiva: vedrai un riepilogo dei tuoi servizi attivi, attività recenti e scadenze prossime.' },
      { text: 'Usa il menu laterale sinistro per navigare tra tutte le sezioni del portale in qualsiasi momento.' },
    ],
  },
  {
    id: 'my-company',
    section: 'La Tua Azienda',
    icon: Building2,
    iconBg: 'bg-indigo-50',
    iconColor: 'text-indigo-600',
    title: 'La Mia Azienda',
    desc: 'Info azienda, servizi e scadenze in un colpo d\'occhio',
    keywords: ['azienda', 'company', 'llc', 'ein', 'stato', 'costituzione', 'registered agent', 'entità', 'info', 'dettagli', 'state', 'formation', 'informazioni'],
    steps: [
      { text: 'Clicca "La Mia Azienda" nel menu a sinistra per vedere il riepilogo della tua azienda.' },
      { text: 'La card Info Azienda mostra: ragione sociale, tipo di entità (LLC/C-Corp), EIN, stato di costituzione, data di costituzione e registered agent.' },
      { text: 'Sotto, Scadenze Prossime elenca le tue prossime 5 scadenze di compliance con stato e data.', sub: 'Clicca "Vedi Tutte" per aprire il calendario completo delle scadenze.' },
      { text: 'Servizi Attivi mostra ogni servizio attualmente in corso con la sua fase attuale (es. "Costituzione", "EIN in Attesa").' },
      { text: 'Servizi Completati mostra tutti i servizi che sono stati consegnati con successo.' },
    ],
    link: { href: '/portal/company', label: 'Vai a La Mia Azienda' },
  },
  {
    id: 'deadlines',
    section: 'La Tua Azienda',
    icon: CalendarDays,
    iconBg: 'bg-teal-50',
    iconColor: 'text-teal-600',
    title: 'Scadenze',
    desc: 'Calendario di compliance e scadenze fiscali',
    keywords: ['scadenza', 'calendario', 'annual report', 'tasse', 'deadline', 'filing', 'compliance', 'rinnovo', 'in scadenza', 'scaduto', 'overdue', 'pending', 'calendar'],
    steps: [
      { text: 'Clicca "Scadenze" nel menu a sinistra per aprire il tracker delle scadenze.' },
      { text: 'In alto: tre tile di riepilogo mostrano il totale, le scadenze in attesa e quelle scadute.' },
      { text: 'Alterna tra Vista Calendario (griglia mensile) e Vista Lista (ordinata per data) con i pulsanti in alto a destra.' },
      { text: 'In Vista Calendario: i puntini colorati appaiono sulle date con scadenze. Clicca qualsiasi data per vedere i dettagli completi.', sub: 'Puntino ambra = In Attesa · Puntino rosso = Scaduto · Puntino verde = Archiviato/Completato' },
      { text: 'In Vista Lista: ogni scadenza pendente mostra il tipo, la data, lo stato e quanti giorni mancano (o quanto è scaduta).' },
      { text: 'Quando una scadenza viene archiviata, il nostro team la marca come "Filed" e diventa verde. Non devi farlo tu.' },
    ],
    link: { href: '/portal/deadlines', label: 'Vai alle Scadenze' },
  },

  // ── Documenti ──
  {
    id: 'documents',
    section: 'Documenti',
    icon: FileText,
    iconBg: 'bg-purple-50',
    iconColor: 'text-purple-600',
    title: 'Documenti',
    desc: 'Sfoglia, visualizza e scarica i tuoi documenti aziendali',
    keywords: ['documento', 'file', 'scarica', 'pdf', 'contratto', 'certificato', 'operating agreement', 'oa', 'lease', 'passaporto', 'carica', 'download', 'upload', 'document', 'lettera ein'],
    steps: [
      { text: 'Clicca "Documenti" nel menu a sinistra per vedere tutti i documenti associati al tuo account.' },
      { text: 'Usa la barra di ricerca in alto per trovare un documento per nome o tipo (es. "Operating Agreement", "EIN Letter").' },
      { text: 'Usa i filtri per categoria per restringere i risultati per tipo (Contratti, Costituzione, Fiscale, Altro).' },
      { text: 'Clicca l\'icona occhio (👁) per visualizzare un documento direttamente nel browser — funziona per PDF e file immagine.' },
      { text: 'Clicca l\'icona download (⬇) per salvare il file sul tuo dispositivo.' },
      { text: 'Per caricare un documento: clicca il pulsante "Carica Documento" in alto a destra, seleziona un file e scegli il tipo di documento.', sub: 'Usa questa funzione per condividere passaporti, bollette o qualsiasi documento richiesto dal nostro team.' },
    ],
    link: { href: '/portal/documents', label: 'Vai ai Documenti' },
  },
  {
    id: 'sign-documents',
    section: 'Documenti',
    icon: PenLine,
    iconBg: 'bg-amber-50',
    iconColor: 'text-amber-600',
    title: 'Firma Documenti',
    desc: 'Firma i contratti e gli accordi della tua LLC',
    keywords: ['firma', 'firmare', 'operating agreement', 'oa', 'lease', 'ss4', 'msa', 'form 8832', 'contratto', 'accordo', 'sign', 'signature', 'documenti da firmare'],
    steps: [
      { text: 'Clicca "Firma Documenti" nel menu a sinistra. Questa sezione appare solo quando hai documenti in attesa della tua firma.' },
      { text: 'Vedrai una lista di documenti con una barra di avanzamento in alto che mostra quanti hai firmato vs quanti rimangono.' },
      { text: 'I tipi di documenti che possono apparire qui includono:', sub: 'Operating Agreement (OA) · Contratto Ufficio (Lease) · SS-4 Richiesta EIN · Contratto di Servizio Annuale · Form 8832 (Elezione C-Corp)' },
      { text: 'Clicca qualsiasi card con l\'icona "penna" blu per aprire la pagina di firma di quel documento.' },
      { text: 'Leggi il documento, poi firma nel pad per la firma (disegna la tua firma con il mouse o il touchscreen).' },
      { text: 'Clicca "Conferma Firma" per finalizzare. La card diventa verde e mostra la data in cui hai firmato.' },
      { text: 'Una volta che tutte le card sono verdi, un\'icona festeggiamento conferma che tutti i documenti sono stati firmati.' },
    ],
    link: { href: '/portal/sign', label: 'Vai a Firma Documenti' },
  },
  {
    id: 'generate-documents',
    section: 'Documenti',
    icon: ScrollText,
    iconBg: 'bg-violet-50',
    iconColor: 'text-violet-600',
    title: 'Genera Documenti',
    desc: 'Crea verbali di distribuzione, certificati fiscali e atti costitutivi',
    keywords: ['genera', 'crea', 'distribuzione', 'verbale', 'certificato fiscale', 'tax statement', 'operating agreement', 'atto', 'utili', 'documento', 'generate', 'resolution', 'distribution'],
    steps: [
      { text: 'Clicca "Genera Documenti" nel menu a sinistra.' },
      { text: 'Seleziona il tipo di documento che vuoi creare:', sub: 'Verbale di Distribuzione — autorizzazione formale per distribuire gli utili ai soci LLC\nCertificato Fiscale — certificato di distribuzione per le autorità fiscali estere\nOperating Agreement — documento costitutivo della tua LLC (rigenera con informazioni aggiornate)' },
      { text: 'Compila i campi richiesti. Per Verbale di Distribuzione e Certificato Fiscale: inserisci importo, anno fiscale, data di distribuzione e valuta (USD o EUR). Per Operating Agreement: inserisci la data di efficacia e gli indirizzi dei soci.' },
      { text: 'Clicca "Anteprima" per vedere come apparirà il documento. I dati aziendali (EIN, stato, soci) vengono compilati automaticamente.' },
      { text: 'Scegli "Scarica PDF" per salvare senza firma, o "Firma e Scarica" per aggiungere la tua firma al documento.' },
      { text: 'Per "Firma e Scarica": disegna la tua firma nel pad che appare, poi clicca "Conferma e Scarica". Il PDF firmato viene salvato sul tuo dispositivo.' },
      { text: 'Tutti i documenti generati sono registrati nella tabella Storico in fondo alla pagina.' },
    ],
    link: { href: '/portal/documents/generate', label: 'Vai a Genera Documenti' },
  },

  // ── Finanza e Fatturazione ──
  {
    id: 'create-invoice',
    section: 'Finanza e Fatturazione',
    icon: Receipt,
    iconBg: 'bg-emerald-50',
    iconColor: 'text-emerald-600',
    title: 'Creare una Fattura di Vendita',
    desc: 'Emetti una fattura a uno dei tuoi clienti',
    keywords: ['fattura', 'invoice', 'crea', 'nuova fattura', 'vendita', 'cliente', 'importo', 'totale', 'scadenza', 'valuta', 'usd', 'eur', 'sconto', 'emettere fattura', 'create invoice', 'line item'],
    steps: [
      { text: 'Vai su Fatture → tab Vendite, poi clicca "Nuova Fattura" in alto a destra.' },
      { text: 'Seleziona un cliente dal menu a tendina, o clicca "Nuovo Cliente" per crearne uno direttamente (nome + email sono sufficienti).' },
      { text: 'Scegli la valuta (USD o EUR) e imposta la data di emissione e la data di scadenza.' },
      { text: 'Per usare un modello: selezionane uno dal menu "Da Modello" — precompilerà le voci e il messaggio.' },
      { text: 'Aggiungi le voci: descrizione, quantità e prezzo unitario. L\'importo viene calcolato automaticamente. Aggiungi altre righe con il pulsante "+ Aggiungi voce".' },
      { text: 'Facoltativamente: inserisci uno sconto, un messaggio per il cliente e note interne (non visibili in fattura).' },
      { text: 'Seleziona quale conto bancario mostrare in fattura (il default è preselezionato dalle impostazioni del profilo).' },
      { text: 'Imposta la ricorrenza se la fattura si ripete: Mensile, Trimestrale o Annuale, con data di fine opzionale.' },
      { text: 'Clicca "Crea Fattura". Verrai reindirizzato alla pagina di dettaglio della fattura dove puoi visualizzarla e inviarla.' },
    ],
    link: { href: '/portal/invoices/new', label: 'Crea una Fattura' },
  },
  {
    id: 'invoice-templates',
    section: 'Finanza e Fatturazione',
    icon: Bookmark,
    iconBg: 'bg-sky-50',
    iconColor: 'text-sky-600',
    title: 'Modelli Fattura',
    desc: 'Salva e riutilizza formati fattura per clienti ricorrenti',
    keywords: ['modello', 'template', 'salva', 'riutilizza', 'ricorrente', 'preimpostato', 'fattura predefinita', 'save', 'reuse'],
    steps: [
      { text: 'Vai su Fatture → tab Vendite. Sotto la lista fatture, clicca "Modelli" per espandere il pannello.' },
      { text: 'Per salvare un nuovo modello: crea una fattura normalmente e in fondo al form cerca "Salva come Modello". Inserisci un nome e salva.' },
      { text: 'La prossima volta che crei una fattura: seleziona il tuo modello dal menu "Da Modello" in alto al form — compilerà automaticamente le voci, la valuta e il messaggio.' },
      { text: 'Per eliminare un modello: espandi il pannello Modelli nella pagina Fatture e clicca l\'icona cestino accanto al modello.' },
    ],
  },
  {
    id: 'customers',
    section: 'Finanza e Fatturazione',
    icon: Users,
    iconBg: 'bg-blue-50',
    iconColor: 'text-blue-600',
    title: 'I Miei Clienti',
    desc: 'Aggiungi e gestisci la tua rubrica clienti per la fatturazione',
    keywords: ['clienti', 'customer', 'rubrica', 'contatti', 'nuovo cliente', 'aggiungi cliente', 'p.iva', 'vat', 'nome cliente', 'directory', 'contacts'],
    steps: [
      { text: 'Clicca "I Miei Clienti" nel menu a sinistra.' },
      { text: 'Per aggiungere un nuovo cliente: clicca "Nuovo Cliente" in alto a destra.' },
      { text: 'Compila i dettagli del cliente:', sub: 'Nome, Cognome, Ragione Sociale · Email · Telefono · Indirizzo (via, città, regione/stato, paese) · P.IVA / Tax ID · Note' },
      { text: 'Clicca "Crea Cliente". Il cliente appare nella lista ed è disponibile nel menu a tendina clienti quando crei fatture.' },
      { text: 'Clicca qualsiasi cliente nella lista per vedere le sue fatture e lo storico pagamenti.' },
      { text: 'Puoi anche aggiungere un nuovo cliente direttamente quando crei una fattura — clicca "Nuovo Cliente" nel campo cliente senza lasciare il form fattura.' },
    ],
    link: { href: '/portal/customers', label: 'Vai a I Miei Clienti' },
  },
  {
    id: 'vendors',
    section: 'Finanza e Fatturazione',
    icon: Building,
    iconBg: 'bg-slate-50',
    iconColor: 'text-slate-600',
    title: 'Fornitori',
    desc: 'Traccia i tuoi fornitori per la gestione delle spese',
    keywords: ['fornitore', 'vendor', 'supplier', 'spesa', 'expense', 'p.iva', 'vat', 'azienda', 'contatto', 'rubrica fornitori', 'aggiungi fornitore'],
    steps: [
      { text: 'Vai su Fatture → tab Fornitori.' },
      { text: 'Clicca "Nuovo Fornitore" per aggiungere un fornitore.' },
      { text: 'Compila i dettagli del fornitore:', sub: 'Ragione Sociale (obbligatoria) · Referente · Email · Telefono · P.IVA / Tax ID · Indirizzo · Note' },
      { text: 'Clicca "Crea". La card del fornitore appare nella griglia.' },
      { text: 'Per modificare un fornitore: clicca l\'icona matita sulla sua card. Per eliminarlo: clicca l\'icona cestino.' },
      { text: 'I fornitori ti aiutano a organizzare le spese. Puoi collegare le spese a un fornitore per mantenere i registri ordinati.' },
    ],
    link: { href: '/portal/invoices?tab=vendors', label: 'Vai ai Fornitori' },
  },
  {
    id: 'td-billing',
    section: 'Finanza e Fatturazione',
    icon: CreditCard,
    iconBg: 'bg-rose-50',
    iconColor: 'text-rose-600',
    title: 'Fatturazione TD',
    desc: 'Visualizza e paga le fatture di Tony Durante verso di te',
    keywords: ['fatturazione', 'fattura tony durante', 'paga', 'pagamento', 'spese', 'td invoice', 'billing', 'pay', 'payment', 'expenses', 'pagare', 'pulsante paga', 'stripe'],
    steps: [
      { text: 'Clicca "TD Billing" nel menu a sinistra. Questo apre la pagina Fatture sul tab Spese.' },
      { text: 'Qui vedi tutte le fatture emesse da Tony Durante LLC verso di te, più le spese che hai caricato manualmente.' },
      { text: 'Il riepilogo in alto mostra: Totale, Pagato e In Attesa.' },
      { text: 'Per pagare una fattura aperta: clicca su di essa, poi clicca il pulsante "Paga Ora". Verrai portato alla pagina di pagamento sicura.', sub: 'Puoi pagare con carta o tramite il metodo di pagamento mostrato.' },
      { text: 'Le fatture pagate mostrano un badge verde "Pagato" e la data del pagamento.' },
      { text: 'Puoi scaricare il PDF di qualsiasi fattura usando l\'icona download a destra.' },
    ],
    link: { href: '/portal/billing', label: 'Vai a TD Billing' },
  },

  // ── Profilo ──
  {
    id: 'edit-profile',
    section: 'Profilo',
    icon: User,
    iconBg: 'bg-zinc-100',
    iconColor: 'text-zinc-600',
    title: 'Modifica Informazioni Personali',
    desc: 'Aggiorna nome, telefono, indirizzo e cittadinanza',
    keywords: ['profilo', 'dati personali', 'modifica', 'nome', 'telefono', 'indirizzo', 'cittadinanza', 'lingua', 'profile', 'personal', 'edit', 'name', 'phone', 'address'],
    steps: [
      { text: 'Clicca "Profilo" nel menu a sinistra.' },
      { text: 'Sotto "Informazioni Personali", clicca il link "Modifica" (icona matita in fondo alla sezione).' },
      { text: 'Aggiorna uno qualsiasi dei seguenti campi:', sub: 'Nome · Cognome · Telefono · Lingua preferita · Cittadinanza · Indirizzo · Città · Stato/Provincia · CAP · Paese' },
      { text: 'L\'indirizzo email è in sola lettura e non può essere modificato qui.', sub: 'Contatta il nostro team via chat se hai bisogno di aggiornare l\'email di accesso.' },
      { text: 'Clicca "Salva" quando hai finito. Le modifiche vengono salvate immediatamente.' },
    ],
    link: { href: '/portal/profile', label: 'Vai al Profilo' },
  },
  {
    id: 'logo',
    section: 'Profilo',
    icon: ImageIcon,
    iconBg: 'bg-pink-50',
    iconColor: 'text-pink-600',
    title: 'Carica il Logo Aziendale',
    desc: 'Aggiungi un logo che appare sulle tue fatture',
    keywords: ['logo', 'immagine', 'brand', 'logo fattura', 'carica logo', 'upload logo', 'image', 'company logo', 'fattura logo'],
    steps: [
      { text: 'Clicca "Profilo" nel menu a sinistra e scorri fino alla sezione "Logo Fattura".' },
      { text: 'Clicca l\'area tratteggiata di upload o il pulsante "Carica" per aprire il selettore file.' },
      { text: 'Seleziona il tuo file logo. Formati accettati: JPEG, PNG, WEBP, SVG. Dimensione massima: 2 MB.' },
      { text: 'Un\'anteprima appare immediatamente dopo il caricamento. Il tuo logo viene salvato automaticamente.' },
      { text: 'Il tuo logo apparirà ora nell\'angolo in alto a sinistra di ogni fattura che crei.' },
      { text: 'Per cambiarlo: clicca "Cambia" accanto al logo attuale e carica un nuovo file.' },
    ],
    link: { href: '/portal/profile', label: 'Vai al Profilo' },
  },
  {
    id: 'bank-accounts',
    section: 'Profilo',
    icon: Landmark,
    iconBg: 'bg-green-50',
    iconColor: 'text-green-600',
    title: 'Conti Bancari',
    desc: 'Aggiungi le tue coordinate bancarie per ricevere pagamenti',
    keywords: ['conto bancario', 'bank account', 'iban', 'routing number', 'numero conto', 'swift', 'bic', 'relay', 'usd', 'eur', 'aggiungi conto', 'coordinate bancarie', 'bonifico', 'banca', 'coordinate'],
    steps: [
      { text: 'Clicca "Profilo" nel menu a sinistra e scorri fino a "Conti Bancari".' },
      { text: 'Clicca "Aggiungi Conto". Scegli la valuta: USD o EUR.' },
      { text: 'Per conti USD, compila:', sub: 'Etichetta (es. "Relay USD") · Titolare del Conto · Nome Banca · Numero Conto · Routing Number · SWIFT/BIC (opzionale) · Note' },
      { text: 'Per conti EUR, compila:', sub: 'Etichetta (es. "Wise EUR") · Titolare del Conto · Nome Banca · IBAN · SWIFT/BIC · Note' },
      { text: 'Attiva "Mostra in fattura" per far apparire i dati di questo conto in fondo alle tue fatture.', sub: 'Solo un conto può essere attivo per le fatture alla volta. Passare a uno nuovo disattiva il precedente.' },
      { text: 'Clicca "Salva". Il conto è ora visibile nel tuo profilo e viene preselezionato quando crei fatture.' },
      { text: 'Per eliminare un conto: clicca l\'icona cestino sulla card del conto.' },
    ],
    link: { href: '/portal/profile', label: 'Vai al Profilo' },
  },
  {
    id: 'payment-links',
    section: 'Profilo',
    icon: Link2,
    iconBg: 'bg-amber-50',
    iconColor: 'text-amber-600',
    title: 'Link di Pagamento',
    desc: 'Aggiungi link Stripe, PayPal o Whop per permettere ai clienti di pagare online',
    keywords: ['link pagamento', 'stripe', 'paypal', 'whop', 'paga ora', 'pulsante paga', 'pagamento online', 'checkout', 'carta', 'payment link', 'pay now', 'pay button'],
    steps: [
      { text: 'Clicca "Profilo" nel menu a sinistra e scorri fino a "Link di Pagamento".' },
      { text: 'Clicca "Aggiungi Link di Pagamento".' },
      { text: 'Compila i campi:', sub: 'Etichetta* (es. "Paga con Stripe") · URL* (il link alla tua pagina di pagamento) · Gateway (Stripe / PayPal / Whop / Altro) · Importo (opzionale) · Valuta (USD o EUR)' },
      { text: 'Clicca Salva. Il link appare ora sulle tue fatture come pulsante "Paga Ora".' },
      { text: 'L\'icona stella imposta un link come predefinito. Clicca per scegliere quale link appare per primo.' },
      { text: 'Usa l\'icona link esterno (↗) per testare l\'URL di pagamento in una nuova scheda.' },
      { text: 'Consigliamo Whop per un checkout senza problemi. Se non hai ancora una pagina Whop, chiedicelo via chat.' },
    ],
    link: { href: '/portal/profile', label: 'Vai al Profilo' },
  },
  {
    id: 'settings',
    section: 'Profilo',
    icon: Lock,
    iconBg: 'bg-zinc-100',
    iconColor: 'text-zinc-500',
    title: 'Impostazioni: Password, Lingua e Notifiche',
    desc: 'Cambia la password, cambia lingua o attiva le notifiche push',
    keywords: ['impostazioni', 'password', 'lingua', 'italiano', 'english', 'notifiche', 'push', 'settings', 'cambia password', 'lingua portale', 'change language', 'notifications'],
    steps: [
      { text: 'Clicca "Profilo" nel menu a sinistra, poi clicca "Impostazioni" (o clicca l\'icona ingranaggio in alto a destra della pagina Profilo).' },
      { text: 'Lingua: clicca "English" o "Italiano" per cambiare la lingua del portale. Il cambio ha effetto immediato.', sub: 'La tua preferenza viene salvata e si applica ogni volta che accedi.' },
      { text: 'Password: inserisci la nuova password (minimo 8 caratteri), confermala, poi clicca "Aggiorna Password".' },
      { text: 'Notifiche Push: clicca il toggle per abilitare le notifiche browser per nuovi messaggi in chat, scadenze e documenti.', sub: 'Il browser chiederà il permesso la prima volta.' },
    ],
    link: { href: '/portal/settings', label: 'Vai alle Impostazioni' },
  },

  // ── Referral ──
  {
    id: 'referrals',
    section: 'Referral',
    icon: Gift,
    iconBg: 'bg-rose-50',
    iconColor: 'text-rose-600',
    title: 'Programma Referral',
    desc: 'Condividi il tuo link e guadagna una commissione per ogni nuovo cliente',
    keywords: ['referral', 'commissione', 'guadagna', 'amico', 'invita', 'link', 'payout', 'pagamento', 'link affiliazione', 'porta un amico', 'guadagno', 'refer', 'earn'],
    steps: [
      { text: 'Clicca "Referral" nel menu a sinistra.' },
      { text: 'Il tuo link referral unico è mostrato in alto. Clicca "Copia Link" per copiarlo negli appunti.', sub: 'Condividi questo link con amici, colleghi o sui social media.' },
      { text: 'Quando qualcuno si iscrive e paga usando il tuo link, appare nella tua lista referral con stato "In Attesa" → "Convertito" → "Accreditato".' },
      { text: 'Significato degli stati:', sub: 'In Attesa (giallo) = si è iscritto, non ancora pagato · Convertito (blu) = ha pagato, commissione confermata · Accreditato (verde) = commissione aggiunta al tuo saldo · Pagato (verde scuro) = commissione trasferita a te' },
      { text: 'La sezione Pagamenti in fondo mostra la cronologia dei pagamenti — importo e metodo.' },
      { text: 'Per domande sul tuo saldo commissioni o per richiedere un pagamento, contattaci via chat.' },
    ],
    link: { href: '/portal/referrals', label: 'Vai ai Referral' },
  },
]

const IT: Content = {
  pageTitle: 'Guida al Portale',
  pageSubtitle: 'Cerca qualsiasi funzionalità, o sfoglia per sezione. Scrivi "logo", "fattura", "Relay", "conto" — troverai tutto.',
  searchPlaceholder: 'Cerca: logo, fattura, Relay, conto bancario, firma…',
  searchNoResults: 'Nessun risultato trovato. Prova parole chiave diverse, o contattaci via chat.',
  searchResultCount: (n) => `${n} risultat${n === 1 ? 'o' : 'i'} trovati`,
  sections: SECTIONS_IT,
  articles: ARTICLES_IT,
  helpTitle: 'Hai ancora domande?',
  helpDesc: 'Il nostro team è disponibile ad aiutarti. Inviaci un messaggio e ti risponderemo a breve.',
  chatBtn: 'Chatta Con Noi',
}
