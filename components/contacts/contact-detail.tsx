'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, User, Mail, Phone, Globe, MapPin,
  Calendar, Shield, FileText, Briefcase, Clock,
  Building2, MessageSquare, KeyRound, CheckCircle2,
  Loader2, ChevronRight, Eye, X, FolderOpen, CreditCard,
  Stethoscope, Send, Zap, Bell, PlayCircle, Paperclip, Wand2, Sparkles,
  ChevronDown as ChevronDownIcon, ExternalLink, Folder, ShieldCheck, RefreshCw,
} from 'lucide-react'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { ComposeEmailButton } from '@/components/inbox/compose-email-button'
import { ChainAuditDialog } from '@/components/contacts/chain-audit-dialog'
import { ContactHealthPanel } from '@/components/contacts/contact-health-panel'
import { ConfirmPaymentDialog } from '@/app/(dashboard)/leads/[id]/components/confirm-payment-dialog'
import { LlcNameSelectionCard } from '@/components/contacts/llc-name-selection-card'
import { SS4PipelineCard } from '@/components/contacts/ss4-pipeline-card'
import { LifecycleTimeline } from '@/components/lifecycle/timeline'
import { assembleTimeline } from '@/lib/lifecycle-timeline'
import { EditableField } from '@/components/accounts/editable-field'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { updateContactField, addContactNote } from '@/app/(dashboard)/contacts/[id]/actions'
import { format, parseISO } from 'date-fns'
import type { LinkedAccount, ServiceDelivery, ConversationEntry } from '@/lib/types'

// ─── Constants ───

const TABS = [
  { key: 'overview', label: 'Overview', icon: User, tooltip: 'Contact details, linked accounts, and offer history.' },
  { key: 'services', label: 'Services', icon: Briefcase, tooltip: 'Active service deliveries for this client — formations, annual reports, etc.' },
  { key: 'invoices', label: 'Invoices', icon: CreditCard, tooltip: 'All invoices and payment history for this client.' },
  { key: 'documents', label: 'Documents', icon: FolderOpen, tooltip: 'Uploaded files — IDs, contracts, certificates, and more.' },
  { key: 'chat', label: 'Chat', icon: MessageSquare, tooltip: 'All communication — portal messages and email threads in one timeline.' },
  { key: 'portal', label: 'Portal', icon: KeyRound, tooltip: 'Client portal access — login status, tier, and portal settings.' },
  { key: 'health', label: 'Health', icon: Stethoscope, tooltip: 'One-screen view of every audit check for this contact — diagnostic + chain audit together.' },
  { key: 'activity', label: 'Activity', icon: MessageSquare, tooltip: 'Account communications timeline — grouped by channel.' },
]

const TIER_COLORS: Record<string, string> = {
  lead: 'bg-zinc-100 text-zinc-600',
  onboarding: 'bg-amber-100 text-amber-700',
  active: 'bg-emerald-100 text-emerald-700',
  full: 'bg-blue-100 text-blue-700',
}

const SD_STATUS_COLORS: Record<string, string> = {
  active: 'bg-blue-100 text-blue-700',
  completed: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-zinc-100 text-zinc-500',
}

const CHANNEL_COLORS: Record<string, string> = {
  WhatsApp: 'bg-green-100 text-green-700',
  Email: 'bg-blue-100 text-blue-700',
  Phone: 'bg-amber-100 text-amber-700',
  Calendly: 'bg-purple-100 text-purple-700',
  Telegram: 'bg-sky-100 text-sky-700',
}

const LANGUAGE_OPTIONS = [
  { value: 'English', label: 'English' },
  { value: 'Italian', label: 'Italian' },
  { value: 'Spanish', label: 'Spanish' },
  { value: 'Portuguese', label: 'Portuguese' },
]

// ─── Helpers ───

function formatDate(d: string | null): string {
  if (!d) return '—'
  try {
    return format(parseISO(d), 'MMM d, yyyy')
  } catch {
    return d
  }
}

function formatDateTime(d: string | null): string {
  if (!d) return '—'
  try {
    return format(parseISO(d), 'MMM d, yyyy h:mm a')
  } catch {
    return d
  }
}

// ─── Types ───

interface ContactRecord {
  id: string
  full_name: string
  first_name: string | null
  last_name: string | null
  email: string | null
  email_2: string | null
  phone: string | null
  phone_2: string | null
  language: string | null
  preferred_channel: string | null
  citizenship: string | null
  residency: string | null
  itin_number: string | null
  itin_issue_date: string | null
  itin_renewal_date: string | null
  passport_on_file: boolean | null
  passport_number: string | null
  passport_expiry_date: string | null
  date_of_birth: string | null
  portal_tier: string | null
  status: string | null
  notes: string | null
  gdrive_folder_url: string | null
  drive_folder_id: string | null
  primary_company_id: string | null
  created_at: string | null
  updated_at: string
}

interface LeadOrigin {
  id: string
  full_name: string
  status: string | null
  source: string | null
  channel: string | null
  reason: string | null
  call_date: string | null
  created_at: string
}

interface PortalAuth {
  exists: boolean
  lastLogin: string | null
  createdAt: string | null
}

interface ContactDocumentRecord {
  id: string
  file_name: string
  document_type_name: string | null
  category_name: string | null
  category: number | null
  drive_file_id: string | null
  drive_link: string | null
  status: string | null
  processed_at: string | null
  mime_type: string | null
  file_size: number | null
  account_id: string | null
}

interface ContactInvoice {
  id: string
  description: string | null
  amount: number
  total: number | null
  amount_currency: string | null
  status: string | null
  invoice_status: string | null
  invoice_number: string | null
  payment_method: string | null
  paid_date: string | null
  due_date: string | null
  installment: string | null
  amount_paid: number | null
  amount_due: number | null
  account_id: string | null
  contact_id: string | null
  portal_invoice_id: string | null
  accounts: { company_name: string } | null
}

interface OfferRecord {
  id: string
  token: string
  client_email: string
  status: string
  contract_type: string | null
  services: unknown
  bundled_pipelines: string[] | null
  selected_services: unknown
  cost_summary: unknown
  created_at: string
  viewed_at: string | null
  expires_at: string | null
}

interface PendingActivationRecord {
  id: string
  client_email: string
  status: string
  signed_at: string | null
  payment_confirmed_at: string | null
  activated_at: string | null
  payment_method: string | null
  amount: number | null
  currency: string | null
}

interface WizardProgressRecord {
  id: string
  contact_id: string
  wizard_type: string
  current_step: number
  status: string
  data: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

interface SS4ApplicationRecord {
  id: string
  token: string
  account_id: string
  company_name: string
  status: string
  signed_at: string | null
  pdf_signed_drive_id: string | null
}

interface ContactDetailProps {
  contact: ContactRecord
  accounts: LinkedAccount[]
  serviceDeliveries: ServiceDelivery[]
  conversations: ConversationEntry[]
  documents: ContactDocumentRecord[]
  invoices: ContactInvoice[]
  lead: LeadOrigin | null
  portalAuth: PortalAuth
  today: string
  offers: OfferRecord[]
  pendingActivations: PendingActivationRecord[]
  wizardProgress: WizardProgressRecord[]
  ss4Applications: SS4ApplicationRecord[]
}

// ─── Main Component ───

export function ContactDetail({
  contact,
  accounts,
  serviceDeliveries,
  conversations,
  documents = [],
  invoices = [],
  lead,
  portalAuth,
  offers = [],
  pendingActivations = [],
  wizardProgress = [],
  ss4Applications = [],
}: ContactDetailProps) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState('overview')
  const [showChainAudit, setShowChainAudit] = useState(false)
  const [chatUnread, setChatUnread] = useState(0)

  const makeContactSaver = (field: string) => async (value: string) => {
    const result = await updateContactField(contact.id, field, value, contact.updated_at)
    if (result.success) toast.success('Saved')
    else toast.error(result.error ?? 'Failed')
    return result
  }

  const activeSds = serviceDeliveries.filter(sd => sd.status === 'active')

  // Assemble lifecycle timeline from existing props
  const timelineEvents = useMemo(() => assembleTimeline({
    lead: lead ? { created_at: lead.created_at, status: lead.status ?? undefined, call_date: lead.call_date } : undefined,
    offers: offers.map(o => {
      const r = o as unknown as Record<string, unknown>
      return { token: (r.token as string) || o.id, status: (r.status as string) || '', created_at: o.created_at, viewed_at: r.viewed_at as string | null, version: r.version as number | null, superseded_by: r.superseded_by as string | null }
    }),
    activations: pendingActivations.map(a => {
      const r = a as unknown as Record<string, unknown>
      return { id: a.id, status: a.status, created_at: (r.created_at as string) || new Date().toISOString(), payment_confirmed_at: a.payment_confirmed_at, amount: a.amount, currency: a.currency }
    }),
    wizardProgress: wizardProgress.map(w => {
      const r = w as unknown as Record<string, unknown>
      return { id: w.id, current_step: w.current_step, status: w.status, created_at: w.created_at, updated_at: w.updated_at, completed_at: r.completed_at as string | null }
    }),
    serviceDeliveries: serviceDeliveries.map(sd => {
      const r = sd as unknown as Record<string, unknown>
      return { id: sd.id, service_type: sd.service_type, service_name: sd.service_name, status: sd.status, created_at: (r.created_at as string) || sd.updated_at }
    }),
    payments: invoices.filter(inv => inv.status === 'Paid' || inv.status === 'paid').map(inv => {
      const r = inv as unknown as Record<string, unknown>
      return { id: inv.id, description: inv.description, amount: inv.amount, status: inv.status, created_at: (r.created_at as string) || new Date().toISOString() }
    }),
  }), [lead, offers, pendingActivations, wizardProgress, serviceDeliveries, invoices])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <button onClick={() => router.back()} className="p-2 rounded-lg hover:bg-zinc-100 transition-colors">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">{contact.full_name}</h1>
              {contact.portal_tier && (
                <span className={cn('text-xs font-medium px-2 py-0.5 rounded', TIER_COLORS[contact.portal_tier] ?? 'bg-zinc-100')}>
                  {contact.portal_tier}
                </span>
              )}
              {contact.status && contact.status !== 'active' && (
                <span className="text-xs font-medium px-2 py-0.5 rounded bg-zinc-100 text-zinc-500">
                  {contact.status}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1">
              {contact.email && <span>{contact.email}</span>}
              {contact.citizenship && <span>· {contact.citizenship}</span>}
              {contact.language && <span>· {contact.language}</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ComposeEmailButton
            contactId={contact.id}
            to={contact.email || undefined}
            linkLabel={contact.full_name || contact.email || undefined}
          />
          <button
            onClick={() => setShowChainAudit(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-violet-100 text-violet-700 hover:bg-violet-200 transition-colors"
            title="Audit the full client lifecycle — lead, offer, activation, account, services, portal, profile completeness."
          >
            <Stethoscope className="h-3.5 w-3.5" />
            Lifecycle Audit
          </button>
        </div>
      </div>

      {/* Quick Actions */}
      <QuickActionsBar
        contact={contact}
        portalAuth={portalAuth}
        offers={offers}
        pendingActivations={pendingActivations}
        wizardProgress={wizardProgress}
        serviceDeliveries={serviceDeliveries}
        lead={lead}
      />

      {/* Journey Tracker */}
      <JourneyTracker
        lead={lead}
        offers={offers}
        pendingActivations={pendingActivations}
        wizardProgress={wizardProgress}
        serviceDeliveries={serviceDeliveries}
        contact={contact}
      />

      {/* Lifecycle Timeline */}
      <LifecycleTimeline events={timelineEvents} defaultOpen={false} />

      {/* Tabs */}
      <div className="border-b">
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map(tab => {
            const Icon = tab.icon
            let count = 0
            if (tab.key === 'services') count = activeSds.length
            if (tab.key === 'invoices') count = invoices.filter(i => i.invoice_number && i.invoice_number !== '1.0' && i.invoice_number !== '2.0').length
            if (tab.key === 'documents') count = documents.length
            if (tab.key === 'chat') count = chatUnread
            if (tab.key === 'activity') count = conversations.length

            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                title={tab.tooltip}
                className={cn(
                  'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                  activeTab === tab.key
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-zinc-300'
                )}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
                {count > 0 && (
                  <span className={cn(
                    'ml-1 px-1.5 py-0.5 text-xs rounded-full font-medium',
                    tab.key === 'chat' && chatUnread > 0 ? 'bg-red-500 text-white' : 'bg-zinc-100 text-zinc-600'
                  )}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <OverviewTab
          contact={contact}
          accounts={accounts}
          lead={lead}
          makeContactSaver={makeContactSaver}
          offers={offers}
          pendingActivations={pendingActivations}
          wizardProgress={wizardProgress}
          ss4Applications={ss4Applications}
          serviceDeliveries={serviceDeliveries}
        />
      )}
      {activeTab === 'services' && (
        <ServicesTab serviceDeliveries={serviceDeliveries} accounts={accounts} contactId={contact.id} />
      )}
      {activeTab === 'invoices' && (
        <InvoicesTab invoices={invoices} />
      )}
      {activeTab === 'documents' && (
        <ContactDocumentsTab documents={documents} accounts={accounts} contactId={contact.id} driveFolderUrl={contact.gdrive_folder_url} driveFolderId={contact.drive_folder_id} />
      )}
      {activeTab === 'chat' && (
        <ChatTab contactId={contact.id} onUnreadChange={setChatUnread} />
      )}
      {activeTab === 'portal' && (
        <PortalTab contact={contact} portalAuth={portalAuth} />
      )}
      {activeTab === 'health' && (
        <ContactHealthPanel contactId={contact.id} contactName={contact.full_name} />
      )}
      {activeTab === 'activity' && (
        <ActivityTab conversations={conversations} />
      )}

      <ChainAuditDialog
        open={showChainAudit}
        onClose={() => setShowChainAudit(false)}
        contactId={contact.id}
        contactName={contact.full_name}
      />
    </div>
  )
}

// ─── Overview Tab ───

function OverviewTab({
  contact,
  accounts,
  lead,
  makeContactSaver,
  offers,
  pendingActivations,
  wizardProgress,
  ss4Applications,
  serviceDeliveries,
}: {
  contact: ContactRecord
  accounts: LinkedAccount[]
  lead: LeadOrigin | null
  makeContactSaver: (field: string) => (value: string) => Promise<{ success: boolean; error?: string }>
  offers: OfferRecord[]
  pendingActivations: PendingActivationRecord[]
  wizardProgress: WizardProgressRecord[]
  ss4Applications: SS4ApplicationRecord[]
  serviceDeliveries: ServiceDelivery[]
}) {
  const [note, setNote] = useState('')
  const [addingNote, setAddingNote] = useState(false)

  const handleAddNote = async () => {
    if (!note.trim()) return
    setAddingNote(true)
    const result = await addContactNote(contact.id, note, contact.updated_at)
    if (result.success) {
      toast.success('Note added')
      setNote('')
    } else {
      toast.error(result.error ?? 'Failed')
    }
    setAddingNote(false)
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Contact Info */}
      <div className="bg-white rounded-lg border p-5 space-y-3">
        <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Contact Info</h3>
        <EditableField icon={Mail} label="Email" value={contact.email ?? ''} onSave={makeContactSaver('email')} />
        <EditableField icon={Mail} label="Email 2" value={contact.email_2 ?? ''} onSave={makeContactSaver('email_2')} />
        <EditableField icon={Phone} label="Phone" value={contact.phone ?? ''} onSave={makeContactSaver('phone')} />
        <EditableField icon={Phone} label="Phone 2" value={contact.phone_2 ?? ''} onSave={makeContactSaver('phone_2')} />
        <EditableField icon={Globe} label="Language" value={contact.language ?? ''} type="select" options={LANGUAGE_OPTIONS} onSave={makeContactSaver('language')} />
        <EditableField icon={Globe} label="Citizenship" value={contact.citizenship ?? ''} onSave={makeContactSaver('citizenship')} />
        <EditableField icon={MapPin} label="Residency" value={contact.residency ?? ''} onSave={makeContactSaver('residency')} />
        <EditableField icon={Calendar} label="Date of Birth" value={contact.date_of_birth ?? ''} type="date" onSave={makeContactSaver('date_of_birth')} />
      </div>

      {/* Identity Documents */}
      <div className="bg-white rounded-lg border p-5 space-y-3">
        <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Identity & Tax</h3>
        <EditableField icon={Shield} label="Passport Number" value={contact.passport_number ?? ''} onSave={makeContactSaver('passport_number')} />
        <EditableField icon={Calendar} label="Passport Expiry" value={contact.passport_expiry_date ?? ''} type="date" onSave={makeContactSaver('passport_expiry_date')} />
        <div className="flex items-center gap-3 py-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Passport on File</span>
          <span className={cn('text-sm font-medium', contact.passport_on_file ? 'text-emerald-600' : 'text-zinc-400')}>
            {contact.passport_on_file ? 'Yes' : 'No'}
          </span>
        </div>
        <EditableField icon={FileText} label="ITIN" value={contact.itin_number ?? ''} onSave={makeContactSaver('itin_number')} />
        <EditableField icon={Calendar} label="ITIN Issue Date" value={contact.itin_issue_date ?? ''} type="date" onSave={makeContactSaver('itin_issue_date')} />
        {contact.itin_renewal_date && (
          <div className="flex items-center gap-3 py-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">ITIN Renewal</span>
            <span className="text-sm">{formatDate(contact.itin_renewal_date)}</span>
          </div>
        )}
      </div>

      {/* Linked Companies */}
      <div className="bg-white rounded-lg border p-5 space-y-3">
        <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">
          Companies ({accounts.length})
        </h3>
        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">No linked companies</p>
        ) : (
          <div className="space-y-2">
            {accounts.map(acc => (
              <Link
                key={acc.id}
                href={`/accounts/${acc.id}`}
                className="flex items-center justify-between p-3 rounded-lg border hover:bg-zinc-50 transition-colors group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{acc.company_name}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {acc.entity_type && <span>{acc.entity_type === 'Single Member LLC' ? 'SMLLC' : acc.entity_type === 'Multi Member LLC' ? 'MMLLC' : acc.entity_type}</span>}
                      {acc.state_of_formation && <span>· {acc.state_of_formation}</span>}
                      {acc.role && <span>· {acc.role}</span>}
                      {acc.ownership_pct != null && <span>· {acc.ownership_pct}%</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {acc.status && (
                    <span className={cn(
                      'text-xs font-medium px-1.5 py-0.5 rounded',
                      acc.status === 'Active' ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-100 text-zinc-500'
                    )}>
                      {acc.status}
                    </span>
                  )}
                  <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Notes + Lead Origin */}
      <div className="space-y-6">
        {/* Notes */}
        <div className="bg-white rounded-lg border p-5 space-y-3">
          <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Notes</h3>
          {contact.notes ? (
            <pre className="text-sm whitespace-pre-wrap text-zinc-700 font-sans">{contact.notes}</pre>
          ) : (
            <p className="text-sm text-muted-foreground">No notes</p>
          )}
          <div className="pt-2 space-y-2">
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Add a note..."
              rows={2}
              className="w-full px-3 py-2 rounded-lg border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleAddNote}
              disabled={!note.trim() || addingNote}
              className="px-3 py-1.5 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 transition-colors"
            >
              {addingNote ? 'Adding...' : 'Add Note'}
            </button>
          </div>
        </div>

        {/* Lead Origin */}
        {lead && (
          <div className="bg-white rounded-lg border p-5 space-y-2">
            <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Lead Origin</h3>
            <div className="text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <span className="font-medium">{lead.status}</span>
              </div>
              {lead.source && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Source</span>
                  <span>{lead.source}</span>
                </div>
              )}
              {lead.channel && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Channel</span>
                  <span>{lead.channel}</span>
                </div>
              )}
              {lead.reason && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Reason</span>
                  <span>{lead.reason}</span>
                </div>
              )}
              {lead.call_date && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Call Date</span>
                  <span>{formatDate(lead.call_date)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Created</span>
                <span>{formatDate(lead.created_at)}</span>
              </div>
              <Link
                href={`/leads/${lead.id}`}
                className="inline-flex items-center gap-1 text-blue-600 hover:underline text-xs mt-1"
              >
                View Lead <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
          </div>
        )}
      </div>

      {/* Offer Status Card */}
      <OfferStatusCard offers={offers} pendingActivations={pendingActivations} />

      {/* Wizard Progress Card */}
      <WizardProgressCard wizardProgress={wizardProgress} pendingActivations={pendingActivations} contactId={contact.id} contactHasDriveFolder={!!contact.gdrive_folder_url} />

      {/* LLC Name Selection Card */}
      <LlcNameSelectionCard
        wizardProgress={wizardProgress}
        accounts={accounts}
        contactId={contact.id}
      />

      {/* SS-4 / EIN Application Pipeline Card */}
      <SS4PipelineCard
        ss4Applications={ss4Applications}
        serviceDeliveries={serviceDeliveries}
        accounts={accounts}
        contactId={contact.id}
      />
    </div>
  )
}

// ─── Quick Actions Bar ───

function QuickActionsBar({
  contact,
  portalAuth,
  offers,
  pendingActivations,
  wizardProgress,
  serviceDeliveries,
  lead,
}: {
  contact: ContactRecord
  portalAuth: PortalAuth
  offers: OfferRecord[]
  pendingActivations: PendingActivationRecord[]
  wizardProgress: WizardProgressRecord[]
  serviceDeliveries: ServiceDelivery[]
  lead: LeadOrigin | null
}) {
  const [loading, setLoading] = useState<string | null>(null)
  const [advanceDialog, setAdvanceDialog] = useState<{ id: string; name: string; stage: string } | null>(null)
  const [showConfirmPayment, setShowConfirmPayment] = useState(false)
  const [showAdvanceDropdown, setShowAdvanceDropdown] = useState(false)

  const hasWizard = wizardProgress.length > 0
  const activeSds = serviceDeliveries.filter(sd => sd.status === 'active')
  const hasPaidOffer = offers.some(o => o.status === 'completed' || o.status === 'signed')

  // Determine which actions to show
  const showCreatePortal = !portalAuth.exists && !!contact.email
  const showResendWelcome = portalAuth.exists && !portalAuth.lastLogin
  const showWizardReminder = contact.portal_tier === 'onboarding' && !hasWizard && (hasPaidOffer || pendingActivations.some(pa => pa.payment_confirmed_at))
  const showAdvanceStage = activeSds.length > 0
  const awaitingPayment = pendingActivations.find(pa => pa.status === 'awaiting_payment')
  const showConfirmPaymentBtn = !!awaitingPayment && !!lead

  const hasActions = showCreatePortal || showResendWelcome || showWizardReminder || showAdvanceStage || showConfirmPaymentBtn

  const handlePortalAction = async (action: string, extra?: Record<string, string>) => {
    setLoading(action)
    try {
      const res = await fetch('/api/crm/admin-actions/contact-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, contact_id: contact.id, ...extra }),
      })
      const data = await res.json()
      if (res.ok) toast.success(data.message)
      else toast.error(data.error ?? 'Failed')
    } catch {
      toast.error('Request failed')
    } finally {
      setLoading(null)
    }
  }

  const handleWizardReminder = async () => {
    setLoading('wizard_reminder')
    try {
      const res = await fetch('/api/crm/admin-actions/contact-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contact.id, action: 'wizard_reminder' }),
      })
      const data = await res.json()
      if (data.success) {
        toast.success(data.detail)
      } else {
        toast.error(data.detail)
      }
    } catch {
      toast.error('Request failed')
    } finally {
      setLoading(null)
    }
  }

  const handleAdvanceStage = async (deliveryId: string) => {
    setLoading('advance_stage')
    try {
      const res = await fetch('/api/crm/admin-actions/contact-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contact.id,
          action: 'advance_stage',
          params: { delivery_id: deliveryId },
        }),
      })
      const data = await res.json()
      if (data.success) {
        const effects = data.side_effects?.join(', ') ?? ''
        toast.success(`${data.detail}${effects ? ` (${effects})` : ''}`)
        setAdvanceDialog(null)
      } else {
        toast.error(data.detail)
      }
    } catch {
      toast.error('Request failed')
    } finally {
      setLoading(null)
    }
  }

  if (!hasActions) return null

  return (
    <>
      <div className="relative z-10 flex flex-wrap items-center gap-2">
        <span title="Quick actions available for this client based on their current stage.">
          <Zap className="h-4 w-4 text-zinc-400" />
        </span>

        {showCreatePortal && (
          <button
            onClick={() => {
              if (!confirm('Create portal account? Client will receive login credentials.')) return
              handlePortalAction('create_portal')
            }}
            disabled={loading === 'create_portal'}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 disabled:opacity-50 transition-colors"
          >
            {loading === 'create_portal' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
            Create Portal
          </button>
        )}

        {showResendWelcome && (
          <button
            onClick={() => {
              if (!confirm('Resend welcome email with new password?')) return
              handlePortalAction('reset_password')
            }}
            disabled={loading === 'reset_password'}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 disabled:opacity-50 transition-colors"
          >
            {loading === 'reset_password' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
            Resend Welcome
          </button>
        )}

        {showWizardReminder && (
          <button
            onClick={handleWizardReminder}
            disabled={loading === 'wizard_reminder'}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100 disabled:opacity-50 transition-colors"
          >
            {loading === 'wizard_reminder' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bell className="h-3.5 w-3.5" />}
            Send Wizard Reminder
          </button>
        )}

        {showAdvanceStage && activeSds.length === 1 && (
          <button
            onClick={() => setAdvanceDialog({
              id: activeSds[0].id,
              name: activeSds[0].service_name ?? activeSds[0].service_type ?? 'Service',
              stage: activeSds[0].stage ?? 'Unknown',
            })}
            disabled={loading === 'advance_stage'}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-50 transition-colors"
          >
            <PlayCircle className="h-3.5 w-3.5" />
            Advance Stage
          </button>
        )}

        {showAdvanceStage && activeSds.length > 1 && (
          <div className="relative">
            <button
              onClick={() => setShowAdvanceDropdown(prev => !prev)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-colors"
            >
              <PlayCircle className="h-3.5 w-3.5" />
              Advance Stage ({activeSds.length})
              <ChevronDownIcon className="h-3 w-3" />
            </button>
            {showAdvanceDropdown && (
              <div className="absolute left-0 top-full mt-1 z-50 bg-white border rounded-lg shadow-xl py-1 min-w-[280px]">
                {activeSds.map(sd => (
                  <button
                    key={sd.id}
                    onClick={() => {
                      setShowAdvanceDropdown(false)
                      setAdvanceDialog({
                        id: sd.id,
                        name: sd.service_name ?? sd.service_type ?? 'Service',
                        stage: sd.stage ?? 'Unknown',
                      })
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-zinc-50 transition-colors"
                  >
                    <p className="font-medium truncate">{sd.service_name ?? sd.service_type ?? 'Service'}</p>
                    <p className="text-xs text-muted-foreground">Current: {sd.stage ?? '—'}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {showConfirmPaymentBtn && (
          <button
            onClick={() => setShowConfirmPayment(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-colors"
          >
            <CreditCard className="h-3.5 w-3.5" />
            Confirm Payment
          </button>
        )}
      </div>

      {/* Confirm Payment Dialog */}
      {showConfirmPayment && lead && (
        <ConfirmPaymentDialog
          open={showConfirmPayment}
          onClose={() => setShowConfirmPayment(false)}
          leadId={lead.id}
          leadName={contact.full_name ?? lead.full_name}
          offer={offers[0] ? {
            token: offers[0].token,
            contract_type: offers[0].contract_type,
            bundled_pipelines: offers[0].bundled_pipelines,
            cost_summary: (offers[0].cost_summary ?? null) as Array<{ label: string; total?: string; items?: Array<{ name: string; price: string }> }> | null,
          } : null}
        />
      )}

      {/* Advance Stage Confirmation Dialog */}
      {advanceDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-semibold">Advance Stage</h3>
            <div className="text-sm space-y-2">
              <p><span className="text-muted-foreground">Service:</span> {advanceDialog.name}</p>
              <p><span className="text-muted-foreground">Current stage:</span> {advanceDialog.stage}</p>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
              <p className="font-medium mb-1">This action triggers auto-chains:</p>
              <ul className="space-y-0.5 text-xs">
                <li>- Auto-tasks created for the new stage</li>
                <li>- Portal notification sent to client</li>
                <li>- Portal tier may upgrade (active → full)</li>
                <li>- Tax return status synced (if Tax Return Filing)</li>
              </ul>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setAdvanceDialog(null)}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-zinc-100 hover:bg-zinc-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleAdvanceStage(advanceDialog.id)}
                disabled={loading === 'advance_stage'}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
              >
                {loading === 'advance_stage' ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
                Confirm Advance
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ─── Journey Tracker ───

type JourneyStepStatus = 'done' | 'current' | 'pending' | 'issue'

interface JourneyStep {
  label: string
  status: JourneyStepStatus
  detail?: string
}

const JOURNEY_STEP_STYLES: Record<JourneyStepStatus, { dot: string; line: string; text: string }> = {
  done: { dot: 'bg-emerald-500', line: 'bg-emerald-500', text: 'text-emerald-700' },
  current: { dot: 'bg-blue-500 ring-4 ring-blue-100', line: 'bg-zinc-200', text: 'text-blue-700' },
  pending: { dot: 'bg-zinc-200', line: 'bg-zinc-200', text: 'text-zinc-400' },
  issue: { dot: 'bg-amber-500 ring-4 ring-amber-100', line: 'bg-zinc-200', text: 'text-amber-700' },
}

function deriveJourneySteps({
  lead,
  offers,
  pendingActivations,
  wizardProgress,
  serviceDeliveries,
  contact,
}: {
  lead: LeadOrigin | null
  offers: OfferRecord[]
  pendingActivations: PendingActivationRecord[]
  wizardProgress: WizardProgressRecord[]
  serviceDeliveries: ServiceDelivery[]
  contact: ContactRecord
}): JourneyStep[] {
  // Find the primary offer (most recent non-draft, or most recent)
  const primaryOffer = offers.find(o => o.status !== 'draft') ?? offers[0] ?? null
  const primaryActivation = pendingActivations[0] ?? null
  const primaryWizard = wizardProgress[0] ?? null
  const formationSds = serviceDeliveries.filter(sd =>
    sd.pipeline === 'Company Formation' || sd.service_type === 'Formation' ||
    (sd.service_name ?? '').toLowerCase().includes('formation')
  )
  const hasActiveServices = serviceDeliveries.some(sd => sd.status === 'active')

  // Formation stage ordering for "beyond Data Collection" check
  const FORMATION_STAGE_ORDER = [
    'Data Collection', 'State Filing', 'EIN Application', 'EIN Submitted', 'Post-Formation + Banking', 'Closing',
  ]

  const formationBeyondDataCollection = formationSds.some(sd => {
    const idx = FORMATION_STAGE_ORDER.indexOf(sd.stage ?? '')
    return idx > 0 // anything after Data Collection
  })

  // 1. Lead step
  let leadStep: JourneyStep
  if (!lead) {
    leadStep = { label: 'Lead', status: 'pending', detail: 'No lead record' }
  } else if (lead.status === 'Converted') {
    leadStep = { label: 'Lead', status: 'done', detail: 'Converted' }
  } else {
    leadStep = { label: 'Lead', status: 'current', detail: lead.status ?? undefined }
  }

  // 2. Offer step
  let offerStep: JourneyStep
  if (!primaryOffer) {
    offerStep = lead
      ? { label: 'Offer', status: 'issue', detail: 'No offer found' }
      : { label: 'Offer', status: 'pending' }
  } else if (['signed', 'completed'].includes(primaryOffer.status)) {
    offerStep = { label: 'Offer', status: 'done', detail: primaryOffer.contract_type ?? undefined }
  } else if (['sent', 'viewed'].includes(primaryOffer.status)) {
    offerStep = { label: 'Offer', status: 'current', detail: primaryOffer.status === 'viewed' ? 'Viewed by client' : 'Sent' }
  } else {
    offerStep = { label: 'Offer', status: 'current', detail: primaryOffer.status }
  }

  // 3. Signed step (from pending_activations.signed_at)
  let signedStep: JourneyStep
  if (primaryActivation?.signed_at) {
    signedStep = { label: 'Signed', status: 'done', detail: formatDate(primaryActivation.signed_at.split('T')[0]) }
  } else if (primaryOffer && ['signed', 'completed'].includes(primaryOffer.status)) {
    // Offer marked signed/completed but no pending_activation — still count as signed
    signedStep = { label: 'Signed', status: 'done' }
  } else if (offerStep.status === 'done' || offerStep.status === 'current') {
    signedStep = { label: 'Signed', status: 'pending', detail: 'Awaiting signature' }
  } else {
    signedStep = { label: 'Signed', status: 'pending' }
  }

  // 4. Paid step
  let paidStep: JourneyStep
  if (primaryActivation?.payment_confirmed_at) {
    paidStep = { label: 'Paid', status: 'done', detail: primaryActivation.payment_method ?? undefined }
  } else if (signedStep.status === 'done' && !primaryActivation?.payment_confirmed_at) {
    // Signed but not paid — check if it's been too long
    const signedDate = primaryActivation?.signed_at ? new Date(primaryActivation.signed_at) : null
    const daysSinceSigned = signedDate ? Math.floor((Date.now() - signedDate.getTime()) / (1000 * 60 * 60 * 24)) : 0
    if (daysSinceSigned > 7) {
      paidStep = { label: 'Paid', status: 'issue', detail: `${daysSinceSigned}d since signing` }
    } else {
      paidStep = { label: 'Paid', status: 'current', detail: 'Awaiting payment' }
    }
  } else {
    paidStep = { label: 'Paid', status: 'pending' }
  }

  // 5. Wizard step
  let wizardStep: JourneyStep
  if (primaryWizard?.status === 'submitted') {
    wizardStep = { label: 'Wizard', status: 'done', detail: primaryWizard.wizard_type }
  } else if (primaryWizard?.status === 'in_progress') {
    wizardStep = { label: 'Wizard', status: 'current', detail: `Step ${primaryWizard.current_step}` }
  } else if (paidStep.status === 'done' && !primaryWizard) {
    // Paid but wizard not started — check how long
    const paidDate = primaryActivation?.payment_confirmed_at ? new Date(primaryActivation.payment_confirmed_at) : null
    const daysSincePaid = paidDate ? Math.floor((Date.now() - paidDate.getTime()) / (1000 * 60 * 60 * 24)) : 0
    if (daysSincePaid > 3) {
      wizardStep = { label: 'Wizard', status: 'issue', detail: `Not started (${daysSincePaid}d)` }
    } else {
      wizardStep = { label: 'Wizard', status: 'current', detail: 'Not started' }
    }
  } else {
    wizardStep = { label: 'Wizard', status: 'pending' }
  }

  // 6. Service step (Formation/Onboarding progress)
  let serviceStep: JourneyStep
  if (formationSds.length > 0) {
    const primaryFormation = formationSds[0]
    if (primaryFormation.stage === 'Closing' || primaryFormation.status === 'completed') {
      serviceStep = { label: 'Service', status: 'done', detail: 'Formation complete' }
    } else if (formationBeyondDataCollection) {
      serviceStep = { label: 'Service', status: 'current', detail: primaryFormation.stage ?? undefined }
    } else if (primaryFormation.stage === 'Data Collection') {
      serviceStep = { label: 'Service', status: 'current', detail: 'Data Collection' }
    } else {
      serviceStep = { label: 'Service', status: 'current', detail: primaryFormation.stage ?? undefined }
    }
  } else if (hasActiveServices) {
    serviceStep = { label: 'Service', status: 'done', detail: 'Active services' }
  } else {
    serviceStep = { label: 'Service', status: 'pending' }
  }

  // 7. Active step
  let activeStep: JourneyStep
  if (contact.portal_tier === 'active' || contact.portal_tier === 'full') {
    activeStep = { label: 'Active', status: 'done', detail: contact.portal_tier }
  } else if (contact.portal_tier === 'onboarding') {
    activeStep = { label: 'Active', status: 'current', detail: 'Onboarding' }
  } else {
    activeStep = { label: 'Active', status: 'pending' }
  }

  return [leadStep, offerStep, signedStep, paidStep, wizardStep, serviceStep, activeStep]
}

function JourneyTracker({
  lead,
  offers,
  pendingActivations,
  wizardProgress,
  serviceDeliveries,
  contact,
}: {
  lead: LeadOrigin | null
  offers: OfferRecord[]
  pendingActivations: PendingActivationRecord[]
  wizardProgress: WizardProgressRecord[]
  serviceDeliveries: ServiceDelivery[]
  contact: ContactRecord
}) {
  const steps = deriveJourneySteps({ lead, offers, pendingActivations, wizardProgress, serviceDeliveries, contact })

  return (
    <div className="bg-white rounded-lg border p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Client Journey</h3>
          <InfoTooltip text="Tracks this client's progress from first contact to active services. Each step shows what's done, what's next, and what needs attention." />
        </div>
      </div>
      {/* Desktop: horizontal pipeline */}
      <div className="hidden sm:flex items-start gap-0">
        {steps.map((step, i) => {
          const styles = JOURNEY_STEP_STYLES[step.status]
          return (
            <div key={step.label} className="flex-1 flex flex-col items-center relative group">
              {/* Connector line (before dot) */}
              {i > 0 && (
                <div className={cn(
                  'absolute top-[11px] right-1/2 h-0.5 w-full',
                  steps[i - 1].status === 'done' ? 'bg-emerald-500' : 'bg-zinc-200'
                )} />
              )}
              {/* Dot */}
              <div className={cn('relative z-10 w-[22px] h-[22px] rounded-full flex items-center justify-center shrink-0', styles.dot)}>
                {step.status === 'done' && (
                  <CheckCircle2 className="h-3.5 w-3.5 text-white" />
                )}
                {step.status === 'current' && (
                  <div className="w-2 h-2 rounded-full bg-white" />
                )}
                {step.status === 'issue' && (
                  <span className="text-white text-[10px] font-bold">!</span>
                )}
              </div>
              {/* Label */}
              <span className={cn('text-xs font-medium mt-1.5', styles.text)}>{step.label}</span>
              {/* Detail tooltip on hover */}
              {step.detail && (
                <span className={cn(
                  'text-[10px] mt-0.5 max-w-[80px] text-center truncate',
                  step.status === 'issue' ? 'text-amber-600' : 'text-muted-foreground'
                )}>
                  {step.detail}
                </span>
              )}
            </div>
          )
        })}
      </div>
      {/* Mobile: vertical compact list */}
      <div className="sm:hidden space-y-2">
        {steps.map(step => {
          const styles = JOURNEY_STEP_STYLES[step.status]
          return (
            <div key={step.label} className="flex items-center gap-3">
              <div className={cn('w-5 h-5 rounded-full flex items-center justify-center shrink-0', styles.dot)}>
                {step.status === 'done' && <CheckCircle2 className="h-3 w-3 text-white" />}
                {step.status === 'current' && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                {step.status === 'issue' && <span className="text-white text-[9px] font-bold">!</span>}
              </div>
              <span className={cn('text-sm font-medium', styles.text)}>{step.label}</span>
              {step.detail && (
                <span className="text-xs text-muted-foreground ml-auto">{step.detail}</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Offer Status Card ───

function OfferStatusCard({
  offers,
  pendingActivations,
}: {
  offers: OfferRecord[]
  pendingActivations: PendingActivationRecord[]
}) {
  const primaryOffer = offers.find(o => o.status !== 'draft') ?? offers[0] ?? null
  const primaryActivation = pendingActivations[0] ?? null

  if (!primaryOffer) {
    return (
      <div className="bg-white rounded-lg border p-5 space-y-2">
        <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Offer</h3>
        <p className="text-sm text-muted-foreground">No offer found</p>
      </div>
    )
  }

  const OFFER_STATUS_COLORS: Record<string, string> = {
    draft: 'bg-zinc-100 text-zinc-600',
    sent: 'bg-blue-100 text-blue-700',
    viewed: 'bg-purple-100 text-purple-700',
    signed: 'bg-emerald-100 text-emerald-700',
    completed: 'bg-emerald-100 text-emerald-700',
  }

  // Parse services from offer
  const services = Array.isArray(primaryOffer.services)
    ? (primaryOffer.services as Array<{ name?: string; description?: string; price?: string }>)
    : []

  return (
    <div className="bg-white rounded-lg border p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Offer</h3>
        <div className="flex items-center gap-2">
          {primaryOffer.contract_type && (
            <span className="text-xs font-medium px-2 py-0.5 rounded bg-zinc-100 text-zinc-600">
              {primaryOffer.contract_type}
            </span>
          )}
          <span className={cn('text-xs font-medium px-2 py-0.5 rounded', OFFER_STATUS_COLORS[primaryOffer.status] ?? 'bg-zinc-100')}>
            {primaryOffer.status}
          </span>
        </div>
      </div>

      {/* Services list */}
      {services.length > 0 && (
        <div className="space-y-1">
          {services.map((svc, i) => (
            <div key={i} className="flex items-center justify-between text-sm">
              <span className="text-zinc-700 truncate">{svc.name ?? svc.description ?? '—'}</span>
              {svc.price && <span className="text-muted-foreground shrink-0 ml-2">{svc.price}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Bundled pipelines */}
      {primaryOffer.bundled_pipelines && primaryOffer.bundled_pipelines.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {primaryOffer.bundled_pipelines.map(p => (
            <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-50 border text-zinc-500">
              {p}
            </span>
          ))}
        </div>
      )}

      {/* Payment info from pending_activation */}
      {primaryActivation && (
        <div className="border-t pt-2 mt-2 space-y-1 text-sm">
          {primaryActivation.signed_at && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Signed</span>
              <span>{formatDate(primaryActivation.signed_at.split('T')[0])}</span>
            </div>
          )}
          {primaryActivation.payment_confirmed_at && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Payment confirmed</span>
              <span>{formatDate(primaryActivation.payment_confirmed_at.split('T')[0])}</span>
            </div>
          )}
          {primaryActivation.payment_method && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Method</span>
              <span className="capitalize">{primaryActivation.payment_method}</span>
            </div>
          )}
          {primaryActivation.amount != null && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Amount</span>
              <span>
                {primaryActivation.currency === 'EUR' ? '\u20AC' : '$'}
                {Number(primaryActivation.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="text-xs text-muted-foreground pt-1">
        Created {formatDate(primaryOffer.created_at.split('T')[0])}
        {primaryOffer.viewed_at && ` · Viewed ${formatDate(primaryOffer.viewed_at.split('T')[0])}`}
      </div>
    </div>
  )
}

// ─── Wizard Progress Card ───

const WIZARD_STEP_LABELS: Record<string, string[]> = {
  formation: ['Personal Info', 'Business Details', 'Documents', 'Review & Submit'],
  onboarding: ['Personal Info', 'Company Details', 'Documents', 'Review & Submit'],
}

function WizardProgressCard({
  wizardProgress,
  pendingActivations,
  contactId,
  contactHasDriveFolder,
}: {
  wizardProgress: WizardProgressRecord[]
  pendingActivations: PendingActivationRecord[]
  contactId: string
  contactHasDriveFolder: boolean
}) {
  const [processing, setProcessing] = useState(false)
  const primaryWizard = wizardProgress[0] ?? null
  const primaryActivation = pendingActivations[0] ?? null

  const handleProcessDocs = async () => {
    setProcessing(true)
    try {
      const res = await fetch('/api/crm/admin-actions/contact-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId, action: 'process_documents' }),
      })
      const data = await res.json()
      if (data.success) {
        toast.success(data.detail)
        if (data.side_effects?.length) toast.info(data.side_effects.join(' | '))
        window.location.reload()
      } else {
        toast.error(data.detail || 'Failed')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setProcessing(false)
    }
  }

  if (!primaryWizard) {
    // Show "not started" with days since payment if applicable
    if (primaryActivation?.payment_confirmed_at) {
      const daysSincePaid = Math.floor(
        (Date.now() - new Date(primaryActivation.payment_confirmed_at).getTime()) / (1000 * 60 * 60 * 24)
      )
      return (
        <div className="bg-white rounded-lg border p-5 space-y-2">
          <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Wizard</h3>
          <div className="flex items-center gap-2">
            <span className={cn(
              'text-xs font-medium px-2 py-0.5 rounded',
              daysSincePaid > 3 ? 'bg-amber-100 text-amber-700' : 'bg-zinc-100 text-zinc-600'
            )}>
              Not started
            </span>
            <span className="text-xs text-muted-foreground">
              {daysSincePaid}d since payment
            </span>
            <WizardReminderButton contactId={contactId} />
          </div>
        </div>
      )
    }
    return (
      <div className="bg-white rounded-lg border p-5 space-y-2">
        <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Wizard</h3>
        <div className="flex items-center gap-2">
          <p className="text-sm text-muted-foreground">No wizard data</p>
          <WizardReminderButton contactId={contactId} />
        </div>
      </div>
    )
  }

  const totalSteps = WIZARD_STEP_LABELS[primaryWizard.wizard_type]?.length ?? 4
  const stepLabels = WIZARD_STEP_LABELS[primaryWizard.wizard_type] ?? []
  const progressPct = primaryWizard.status === 'submitted' ? 100 : Math.round((primaryWizard.current_step / totalSteps) * 100)

  return (
    <div className="bg-white rounded-lg border p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Wizard</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium px-2 py-0.5 rounded bg-zinc-100 text-zinc-600">
            {primaryWizard.wizard_type}
          </span>
          <span className={cn(
            'text-xs font-medium px-2 py-0.5 rounded',
            primaryWizard.status === 'submitted' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'
          )}>
            {primaryWizard.status === 'submitted' ? 'Submitted' : 'In progress'}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Step {primaryWizard.current_step} of {totalSteps}</span>
          <span>{progressPct}%</span>
        </div>
        <div className="h-2 bg-zinc-100 rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              primaryWizard.status === 'submitted' ? 'bg-emerald-500' : 'bg-blue-500'
            )}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Step labels */}
      {stepLabels.length > 0 && (
        <div className="grid grid-cols-4 gap-1">
          {stepLabels.map((label, i) => {
            const stepNum = i + 1
            const isDone = primaryWizard.status === 'submitted' || stepNum < primaryWizard.current_step
            const isCurrent = primaryWizard.status !== 'submitted' && stepNum === primaryWizard.current_step
            return (
              <div key={label} className="text-center">
                <div className={cn(
                  'text-[10px] font-medium',
                  isDone ? 'text-emerald-600' : isCurrent ? 'text-blue-600' : 'text-zinc-400'
                )}>
                  {label}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {primaryWizard.status === 'submitted'
            ? `Submitted ${formatDate(primaryWizard.updated_at.split('T')[0])}`
            : `Last updated ${formatDate(primaryWizard.updated_at.split('T')[0])}`
          }
        </div>
        {primaryWizard.status === 'submitted' && (
          contactHasDriveFolder ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-700">
              <CheckCircle2 className="h-3 w-3" />
              Documents processed
            </span>
          ) : (
            <button
              onClick={handleProcessDocs}
              disabled={processing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 disabled:opacity-50 transition-colors"
            >
              {processing ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />}
              Process Documents
            </button>
          )
        )}
      </div>
    </div>
  )
}

// ─── Wizard Reminder Button (inline) ───

function WizardReminderButton({ contactId }: { contactId: string }) {
  const [sending, setSending] = useState(false)

  const handleSend = async () => {
    setSending(true)
    try {
      const res = await fetch('/api/crm/admin-actions/contact-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId, action: 'send_wizard_reminder' }),
      })
      const data = await res.json()
      if (data.success) {
        toast.success(data.detail || 'Wizard reminder sent')
      } else {
        toast.error(data.error || 'Failed to send reminder')
      }
    } catch {
      toast.error('Failed to send reminder')
    } finally {
      setSending(false)
    }
  }

  return (
    <button
      onClick={handleSend}
      disabled={sending}
      className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100 disabled:opacity-50 transition-colors"
      title="Send wizard reminder email to client"
    >
      {sending ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Bell className="h-2.5 w-2.5" />}
      Remind
    </button>
  )
}

// ─── Chat Tab ───

interface ChatMessage {
  id: string
  account_id: string | null
  contact_id: string | null
  sender_type: 'client' | 'admin'
  message: string
  attachment_url: string | null
  attachment_name: string | null
  read_at: string | null
  created_at: string
  source: string
}

interface GmailThread {
  id: string
  subject: string
  from: string
  snippet: string
  date: string
  unread: boolean
  messageCount: number
}

function ChatTab({
  contactId,
  onUnreadChange,
}: {
  contactId: string
  onUnreadChange: (count: number) => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [gmailThreads, setGmailThreads] = useState<GmailThread[]>([])
  const [gmailLoading, setGmailLoading] = useState(true)
  const [notifications, setNotifications] = useState<Array<{ id: string; type: string; title: string; body: string | null; created_at: string }>>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [draft, setDraft] = useState('')
  const [pendingFile, setPendingFile] = useState<{ name: string; url?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notifOpen, setNotifOpen] = useState(false)
  const [polishing, setPolishing] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }, [draft])

  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch(`/api/contacts/${contactId}/communications`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setMessages(data.messages ?? [])
      setNotifications(data.notifications ?? [])
      setGmailThreads(data.gmailThreads ?? [])
      setGmailLoading(false)
      onUnreadChange(data.unreadCount ?? 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setGmailLoading(false)
    } finally {
      setLoading(false)
    }
  }, [contactId, onUnreadChange])

  useEffect(() => {
    fetchMessages()
  }, [fetchMessages])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleFileSelect = async (file: File) => {
    if (file.size > 10 * 1024 * 1024) {
      toast.error('File too large (max 10 MB)')
      return
    }
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/portal/chat/upload', { method: 'POST', body: formData })
      if (!res.ok) throw new Error('Upload failed')
      const data = await res.json()
      setPendingFile({ name: file.name, url: data.url })
    } catch {
      toast.error('File upload failed')
    } finally {
      setUploading(false)
    }
  }

  const handleSend = async () => {
    if ((!draft.trim() && !pendingFile) || sending) return
    setSending(true)
    try {
      const res = await fetch('/api/portal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contactId,
          message: draft.trim() || (pendingFile ? `[Attachment: ${pendingFile.name}]` : ''),
          ...(pendingFile?.url ? { attachment_url: pendingFile.url, attachment_name: pendingFile.name } : {}),
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      setDraft('')
      setPendingFile(null)
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      await fetchMessages()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to send')
    } finally {
      setSending(false)
    }
  }

  const handlePolish = async () => {
    if (!draft.trim() || polishing) return
    setPolishing(true)
    try {
      const res = await fetch('/api/portal/chat/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: draft }),
      })
      if (!res.ok) throw new Error('Polish failed')
      const data = await res.json()
      if (data.polished) setDraft(data.polished)
    } catch {
      toast.error('AI polish failed')
    } finally {
      setPolishing(false)
    }
  }

  const handleSuggest = async () => {
    if (suggesting) return
    setSuggesting(true)
    try {
      // Build context from last few messages
      const recentMsgs = messages.slice(-5).map(m => ({
        role: m.sender_type === 'admin' ? 'admin' : 'client',
        content: m.message,
      }))
      const res = await fetch('/api/portal/chat/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: recentMsgs, contact_id: contactId }),
      })
      if (!res.ok) throw new Error('Suggest failed')
      const data = await res.json()
      if (data.suggestion) setDraft(data.suggestion)
    } catch {
      toast.error('AI suggest failed')
    } finally {
      setSuggesting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-50 rounded-lg p-4 text-sm text-red-700">
        Failed to load chat: {error}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Messages — merged timeline of portal chat + Gmail threads */}
      <div className="bg-white rounded-lg border">
        {messages.length === 0 && gmailThreads.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No communications yet</p>
          </div>
        ) : (
          <div className="max-h-[500px] overflow-y-auto p-4 space-y-3">
            {/* Build merged timeline */}
            {(() => {
              type TimelineItem =
                | { type: 'chat'; date: string; data: ChatMessage }
                | { type: 'email'; date: string; data: GmailThread }

              const items: TimelineItem[] = [
                ...messages.map(m => ({ type: 'chat' as const, date: m.created_at, data: m })),
                ...gmailThreads.map(t => ({ type: 'email' as const, date: t.date, data: t })),
              ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

              return items.map(item => {
                if (item.type === 'chat') {
                  const msg = item.data
                  return (
                    <div
                      key={msg.id}
                      className={cn(
                        'flex gap-3',
                        msg.sender_type === 'admin' ? 'flex-row-reverse' : ''
                      )}
                    >
                      <div className={cn(
                        'max-w-[70%] rounded-lg px-3 py-2',
                        msg.sender_type === 'admin'
                          ? 'bg-blue-50 text-blue-900'
                          : 'bg-zinc-100 text-zinc-900'
                      )}>
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className={cn(
                            'text-[10px] font-medium uppercase',
                            msg.sender_type === 'admin' ? 'text-blue-500' : 'text-zinc-500'
                          )}>
                            {msg.sender_type === 'admin' ? 'Staff' : 'Client'}
                          </span>
                          {msg.source !== 'Personal' && (
                            <span className="text-[10px] text-zinc-400">via {msg.source}</span>
                          )}
                        </div>
                        <p className="text-sm whitespace-pre-wrap break-words">{msg.message}</p>
                        {msg.attachment_url && (
                          <a
                            href={msg.attachment_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline mt-1"
                          >
                            <FileText className="h-3 w-3" />
                            {msg.attachment_name ?? 'Attachment'}
                          </a>
                        )}
                        <p className="text-[10px] text-zinc-400 mt-1">
                          {formatDateTime(msg.created_at)}
                        </p>
                      </div>
                    </div>
                  )
                }

                // Gmail thread card
                const thread = item.data
                return (
                  <Link
                    key={`gmail-${thread.id}`}
                    href={`/inbox?thread=${thread.id}`}
                    className="block rounded-lg border border-zinc-200 hover:border-zinc-300 hover:shadow-sm transition-all p-3 bg-white"
                  >
                    <div className="flex items-start gap-2.5">
                      <div className="flex items-center justify-center h-7 w-7 rounded-full bg-red-50 shrink-0 mt-0.5">
                        <Mail className="h-3.5 w-3.5 text-red-500" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className={cn('text-sm font-medium truncate', thread.unread && 'font-semibold text-zinc-900')}>
                            {thread.subject}
                          </p>
                          {thread.unread && (
                            <span className="h-2 w-2 rounded-full bg-blue-500 shrink-0" />
                          )}
                        </div>
                        <p className="text-xs text-zinc-500 truncate mt-0.5">
                          {thread.from} {thread.messageCount > 1 && `(${thread.messageCount} messages)`}
                        </p>
                        <p className="text-xs text-zinc-400 truncate mt-0.5">{thread.snippet}</p>
                        <p className="text-[10px] text-zinc-400 mt-1">
                          {formatDateTime(thread.date)}
                        </p>
                      </div>
                    </div>
                  </Link>
                )
              })
            })()}
            {gmailLoading && (
              <div className="flex items-center gap-2 py-2 text-xs text-zinc-400">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading email history...
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}

        {/* Pending file preview */}
        {pendingFile && (
          <div className="mx-3 mb-2 flex items-center gap-2 p-2 bg-blue-50 rounded-lg text-sm">
            <Paperclip className="h-4 w-4 text-blue-500 shrink-0" />
            <span className="truncate text-blue-700">{pendingFile.name}</span>
            <button onClick={() => setPendingFile(null)} className="ml-auto text-blue-400 hover:text-blue-600 shrink-0">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Send area — portal chat style */}
        <div className="border-t p-3">
          <div className="flex items-end gap-2">
            {/* Paperclip */}
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className={cn(
                'p-2 rounded-full transition-colors shrink-0',
                pendingFile
                  ? 'text-blue-600 bg-blue-100 hover:bg-blue-200'
                  : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 disabled:opacity-50'
              )}
            >
              {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Paperclip className="h-5 w-5" />}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={e => { if (e.target.files?.[0]) handleFileSelect(e.target.files[0]) }}
              className="hidden"
            />
            {/* Auto-growing textarea */}
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              rows={1}
              placeholder="Type a message... (Enter to send)"
              className="flex-1 min-w-0 px-3 py-2.5 text-sm bg-transparent border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none overflow-y-auto max-h-[120px] placeholder:text-zinc-400"
            />
            {/* AI Polish — appears when text typed */}
            {draft.trim() && (
              <button
                onClick={handlePolish}
                disabled={polishing}
                className="p-2 rounded-full bg-violet-100 text-violet-600 hover:bg-violet-200 disabled:opacity-50 transition-colors shrink-0"
                title="AI Polish — clean up grammar"
              >
                {polishing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wand2 className="h-5 w-5" />}
              </button>
            )}
            {/* AI Suggest — appears when no text */}
            {!draft.trim() && messages.length > 0 && (
              <button
                onClick={handleSuggest}
                disabled={suggesting}
                className="p-2 rounded-full bg-violet-50 text-violet-500 hover:bg-violet-100 disabled:opacity-50 transition-colors shrink-0"
                title="AI Suggest — generate reply"
              >
                {suggesting ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />}
              </button>
            )}
            {/* Send button */}
            {sending ? (
              <button disabled className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center shrink-0">
                <Loader2 className="h-5 w-5 animate-spin" />
              </button>
            ) : (draft.trim() || pendingFile) ? (
              <button
                onClick={handleSend}
                disabled={uploading}
                className="w-10 h-10 rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center shrink-0 transition-colors"
              >
                <Send className="h-5 w-5" />
              </button>
            ) : (
              <div className="w-10 h-10 rounded-full bg-zinc-100 text-zinc-400 flex items-center justify-center shrink-0">
                <Send className="h-5 w-5" />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Notification History — collapsible */}
      {notifications.length > 0 && (
        <div className="bg-white rounded-lg border">
          <button
            onClick={() => setNotifOpen(!notifOpen)}
            className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-zinc-50 transition-colors"
          >
            <span className="font-semibold text-xs text-muted-foreground uppercase tracking-wider">
              Notification History ({notifications.length})
            </span>
            <ChevronDownIcon className={cn('h-4 w-4 text-zinc-400 transition-transform', notifOpen && 'rotate-180')} />
          </button>
          {notifOpen && (
            <div className="border-t px-4 py-3 space-y-2">
              {notifications.slice(0, 10).map(n => (
                <div key={n.id} className="flex items-start gap-3 text-sm">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-2 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium text-zinc-800">{n.title}</p>
                    {n.body && <p className="text-xs text-zinc-500 truncate">{n.body}</p>}
                    <p className="text-[10px] text-zinc-400">{formatDateTime(n.created_at)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Services Tab ───

function ServicesTab({
  serviceDeliveries,
  accounts,
  contactId,
}: {
  serviceDeliveries: ServiceDelivery[]
  accounts: LinkedAccount[]
  contactId: string
}) {
  const [cancelling, setCancelling] = useState<string | null>(null)
  const accountMap = new Map(accounts.map(a => [a.id, a.company_name]))

  const handleCancel = async (sdId: string, sdName: string) => {
    if (!confirm(`Cancel "${sdName}"? This will close all linked tasks.`)) return
    setCancelling(sdId)
    try {
      const res = await fetch('/api/crm/admin-actions/contact-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId, action: 'cancel_service', params: { delivery_id: sdId } }),
      })
      const data = await res.json()
      if (data.success) {
        toast.success(data.detail)
        window.location.reload()
      } else {
        toast.error(data.detail || 'Failed')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setCancelling(null)
    }
  }

  if (serviceDeliveries.length === 0) {
    return (
      <div className="bg-white rounded-lg border p-8 text-center text-sm text-muted-foreground">
        No service deliveries found
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border overflow-hidden">
      <div className="hidden md:grid md:grid-cols-[1fr,120px,1fr,100px,80px,100px,50px] gap-3 px-4 py-2.5 border-b bg-zinc-50 text-xs font-medium text-muted-foreground uppercase tracking-wider">
        <span>Service</span>
        <span>Type</span>
        <span>Stage</span>
        <span>Status</span>
        <span>Assigned</span>
        <span>Account</span>
        <span></span>
      </div>
      {serviceDeliveries.map(sd => (
        <div
          key={sd.id}
          className={cn(
            "grid grid-cols-1 md:grid-cols-[1fr,120px,1fr,100px,80px,100px,50px] gap-1 md:gap-3 px-4 py-3 border-b last:border-b-0 hover:bg-zinc-50 transition-colors items-center",
            sd.status === 'cancelled' && 'opacity-50'
          )}
        >
          <div className="font-medium text-sm truncate">{sd.service_name ?? sd.service_type ?? '—'}</div>
          <div className="text-xs text-muted-foreground">{sd.service_type ?? '—'}</div>
          <div className="text-sm truncate">{sd.stage ?? '—'}</div>
          <div>
            <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded', SD_STATUS_COLORS[sd.status ?? ''] ?? 'bg-zinc-100 text-zinc-600')}>
              {sd.status ?? '—'}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">{sd.assigned_to ?? '—'}</div>
          <div className="text-xs text-muted-foreground truncate">
            {sd.account_id ? (
              <Link href={`/accounts/${sd.account_id}`} className="text-blue-600 hover:underline">
                {accountMap.get(sd.account_id) ?? 'Account'}
              </Link>
            ) : (
              <span className="text-zinc-400">Direct</span>
            )}
          </div>
          <div className="flex justify-center">
            {sd.status === 'active' && (
              <button
                onClick={() => handleCancel(sd.id, sd.service_name ?? sd.service_type ?? 'Service')}
                disabled={cancelling === sd.id}
                className="p-1 rounded hover:bg-red-50 text-zinc-400 hover:text-red-600 transition-colors disabled:opacity-50"
                title="Cancel service"
              >
                {cancelling === sd.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Portal Tab ───

function PortalTab({
  contact,
  portalAuth,
}: {
  contact: ContactRecord
  portalAuth: PortalAuth
}) {
  const [loading, setLoading] = useState<string | null>(null)
  const [tier, setTier] = useState(contact.portal_tier ?? '')
  const [portalExists, setPortalExists] = useState(portalAuth.exists)

  const handleAction = async (action: string, extra?: Record<string, string>) => {
    setLoading(action)
    try {
      const res = await fetch('/api/crm/admin-actions/contact-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, contact_id: contact.id, ...extra }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(data.message)
        if (action === 'create_portal') setPortalExists(true)
      } else {
        toast.error(data.error ?? 'Failed')
      }
    } catch {
      toast.error('Request failed')
    } finally {
      setLoading(null)
    }
  }

  const handleReconcileTier = async () => {
    const ok = confirm(
      'Reconcile Portal Tier?\n\n' +
      'Forces this contact\'s tier, all linked accounts, and the portal login to use the same value. ' +
      'Source of truth is the contact\'s current tier. ' +
      'Safe to run any time — no-op if everything is already in sync.',
    )
    if (!ok) return
    setLoading('reconcile_tier')
    try {
      const res = await fetch('/api/crm/admin-actions/reconcile-portal-tier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contact.id, reason: 'Reconcile button from Contact → Portal tab' }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(data.message)
        if (data.changed?.contact || data.changed?.accounts?.length > 0 || data.changed?.auth_user) {
          setTimeout(() => window.location.reload(), 1200)
        }
      } else {
        toast.error(data.error ?? 'Reconcile failed')
      }
    } catch {
      toast.error('Request failed')
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="max-w-lg space-y-6">
      {/* Portal Status */}
      <div className="bg-white rounded-lg border p-5 space-y-4">
        <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Portal Status</h3>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Account</span>
            <div className="flex items-center gap-2">
              {portalExists ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  <span className="text-sm font-medium text-emerald-700">Active</span>
                </>
              ) : (
                <span className="text-sm text-zinc-400">Not created</span>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Tier</span>
            <span className={cn('text-xs font-medium px-2 py-0.5 rounded', TIER_COLORS[contact.portal_tier ?? ''] ?? 'bg-zinc-100')}>
              {contact.portal_tier ?? 'none'}
            </span>
          </div>

          {portalAuth.lastLogin && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Last Login</span>
              <span className="text-sm">{formatDateTime(portalAuth.lastLogin)}</span>
            </div>
          )}

          {portalAuth.createdAt && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Created</span>
              <span className="text-sm">{formatDate(portalAuth.createdAt)}</span>
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Email</span>
            <span className="text-sm">{contact.email ?? '—'}</span>
          </div>
        </div>
      </div>

      {/* Admin Actions */}
      <div className="bg-white rounded-lg border p-5 space-y-4">
        <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Admin Actions</h3>

          {!portalExists ? (
            <button
              onClick={() => {
                if (!confirm('Create portal account? Client will receive login credentials via email.')) return
                handleAction('create_portal')
              }}
              disabled={loading === 'create_portal' || !contact.email}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 text-sm font-medium hover:bg-blue-100 disabled:opacity-50 transition-colors"
            >
              {loading === 'create_portal' ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Create Portal Account
            </button>
          ) : (
            <div className="space-y-4">
              {/* Change Tier */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Change Tier</label>
                <div className="flex items-center gap-2">
                  <select
                    value={tier}
                    onChange={e => setTier(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-lg border text-sm"
                  >
                    <option value="lead">lead</option>
                    <option value="onboarding">onboarding</option>
                    <option value="active">active</option>
                    <option value="full">full</option>
                  </select>
                  <button
                    onClick={() => handleAction('change_tier', { tier })}
                    disabled={loading === 'change_tier' || tier === contact.portal_tier}
                    className="px-3 py-2 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 transition-colors"
                  >
                    {loading === 'change_tier' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Update'}
                  </button>
                </div>
              </div>

              {/* Reset Password */}
              <button
                onClick={() => {
                  if (!confirm('Reset portal password? New credentials will be sent via email.')) return
                  handleAction('reset_password')
                }}
                disabled={loading === 'reset_password'}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-700 text-sm font-medium hover:bg-amber-100 disabled:opacity-50 transition-colors"
              >
                {loading === 'reset_password' ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                Reset Password
              </button>
            </div>
          )}

          {/* Reconcile Portal Tier — P3.4 #2. Visible regardless of portalExists
              because tier drift (contact vs linked accounts vs auth user) can
              exist whenever the contact has a tier, with or without an auth
              user. reconcileTier handles the "no auth user" case gracefully. */}
          <button
            onClick={handleReconcileTier}
            disabled={loading === 'reconcile_tier' || !contact.portal_tier}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 text-sm font-medium hover:bg-indigo-100 disabled:opacity-50 transition-colors mt-3"
            title="Force contact, linked accounts, and portal login to use the same tier"
          >
            {loading === 'reconcile_tier' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Reconcile Portal Tier
          </button>
        </div>
    </div>
  )
}

// ─── Documents Tab ───

const CATEGORY_COLORS: Record<string, string> = {
  Company: 'bg-blue-100 text-blue-700',
  Contacts: 'bg-purple-100 text-purple-700',
  Tax: 'bg-amber-100 text-amber-700',
  Banking: 'bg-emerald-100 text-emerald-700',
  Correspondence: 'bg-zinc-100 text-zinc-600',
  // Canonical contact-side sections
  Identity: 'bg-purple-100 text-purple-700',
  ITIN: 'bg-indigo-100 text-indigo-700',
  Other: 'bg-zinc-100 text-zinc-600',
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ─── Contact File Browser (reads Drive folder tree via API) ──────────────
function ContactFileBrowser({ contactId, driveFolderId: _driveFolderId }: { contactId: string; driveFolderId: string }) {
  const [data, setData] = useState<{ folders: { id: string; name: string; files: { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string }[]; subfolders: { id: string; name: string; files: { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string }[] }[] }[]; rootFiles: { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string }[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [processing, setProcessing] = useState<string | null>(null)

  const handleProcess = async (driveFileId: string, fileName: string) => {
    setProcessing(driveFileId)
    try {
      const { processContactFile } = await import('@/app/(dashboard)/contacts/folder-actions')
      const result = await processContactFile(contactId, driveFileId, fileName)
      if (result.success) {
        toast.success(`Processed "${fileName}"${result.data?.documentId ? ' — OCR complete' : ''}`)
        window.location.reload()
      } else {
        toast.error(result.error ?? 'Processing failed')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Processing failed')
    } finally {
      setProcessing(null)
    }
  }

  const fetchFiles = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/contacts/${contactId}/files`)
      const json = await res.json()
      if (json.error && !json.folders) {
        setError(json.error)
      } else {
        setData(json)
        // Auto-expand all folders
        const exp: Record<string, boolean> = {}
        for (const f of json.folders || []) exp[f.id] = true
        setExpanded(exp)
      }
    } catch {
      setError('Failed to load files')
    } finally {
      setLoading(false)
    }
  }, [contactId])

  useEffect(() => { fetchFiles() }, [fetchFiles])

  if (loading) return <div className="flex items-center gap-2 py-4 justify-center text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading files...</div>
  if (error) return <div className="text-center py-4 text-sm text-zinc-400">{error} <button onClick={fetchFiles} className="text-blue-600 hover:underline ml-1">Retry</button></div>
  if (!data) return null

  const totalFiles = (data.folders || []).reduce((sum, f) => sum + f.files.length + f.subfolders.reduce((s, sf) => s + sf.files.length, 0), 0) + (data.rootFiles || []).length

  return (
    <div className="border rounded-lg bg-white">
      <div className="flex items-center justify-between px-3 py-2 border-b bg-zinc-50">
        <span className="text-xs text-zinc-500">{totalFiles} files in Drive</span>
        <button onClick={fetchFiles} className="text-xs text-zinc-400 hover:text-zinc-600 flex items-center gap-1">
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>
      {(data.folders || []).map(folder => (
        <div key={folder.id}>
          <button
            onClick={() => setExpanded(prev => ({ ...prev, [folder.id]: !prev[folder.id] }))}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            {expanded[folder.id] ? <ChevronDownIcon className="h-3.5 w-3.5 text-zinc-400" /> : <ChevronRight className="h-3.5 w-3.5 text-zinc-400" />}
            <FolderOpen className="h-3.5 w-3.5 text-amber-500" />
            <span className="flex-1 text-left">{folder.name}</span>
            <span className="text-xs text-zinc-400">{folder.files.length + folder.subfolders.reduce((s, sf) => s + sf.files.length, 0)}</span>
          </button>
          {expanded[folder.id] && (
            <div className="border-l ml-5 pl-2">
              {folder.files.map(file => (
                <div key={file.id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-zinc-50 group">
                  <FileText className="h-3.5 w-3.5 text-zinc-400" />
                  <a href={`/api/drive-preview/${file.id}`} target="_blank" rel="noopener noreferrer" className="flex-1 truncate text-zinc-600 hover:text-blue-600">{file.name}</a>
                  {file.size && <span className="text-xs text-zinc-400">{formatFileSize(Number(file.size))}</span>}
                  <button
                    onClick={() => handleProcess(file.id, file.name)}
                    disabled={processing === file.id}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-blue-50 text-zinc-400 hover:text-blue-600 transition-all disabled:opacity-50"
                    title="Process & OCR"
                  >
                    {processing === file.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  </button>
                </div>
              ))}
              {folder.subfolders.map(sf => (
                <div key={sf.id}>
                  <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-zinc-500">
                    <Folder className="h-3 w-3 text-amber-400" /> {sf.name} ({sf.files.length})
                  </div>
                  {sf.files.map(file => (
                    <div key={file.id} className="flex items-center gap-2 px-3 py-1.5 ml-4 text-sm hover:bg-zinc-50 group">
                      <FileText className="h-3.5 w-3.5 text-zinc-400" />
                      <a href={`/api/drive-preview/${file.id}`} target="_blank" rel="noopener noreferrer" className="flex-1 truncate text-zinc-600 hover:text-blue-600">{file.name}</a>
                      <button
                        onClick={() => handleProcess(file.id, file.name)}
                        disabled={processing === file.id}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-blue-50 text-zinc-400 hover:text-blue-600 transition-all disabled:opacity-50"
                        title="Process & OCR"
                      >
                        {processing === file.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  ))}
                </div>
              ))}
              {folder.files.length === 0 && folder.subfolders.length === 0 && (
                <p className="px-3 py-1.5 text-xs text-zinc-400 italic">Empty</p>
              )}
            </div>
          )}
        </div>
      ))}
      {(data.rootFiles || []).length > 0 && (
        <div className="border-t px-3 py-2">
          <p className="text-xs text-zinc-400 mb-1">Root files</p>
          {data.rootFiles.map(file => (
            <div key={file.id} className="flex items-center gap-2 py-1 text-sm group">
              <FileText className="h-3.5 w-3.5 text-zinc-400" />
              <a href={`/api/drive-preview/${file.id}`} target="_blank" rel="noopener noreferrer" className="flex-1 truncate text-zinc-600 hover:text-blue-600">{file.name}</a>
              <button
                onClick={() => handleProcess(file.id, file.name)}
                disabled={processing === file.id}
                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-blue-50 text-zinc-400 hover:text-blue-600 transition-all disabled:opacity-50"
                title="Process & OCR"
              >
                {processing === file.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ContactDocumentsTab({
  documents,
  accounts,
  contactId,
  driveFolderUrl,
  driveFolderId,
}: {
  documents: ContactDocumentRecord[]
  accounts: LinkedAccount[]
  contactId: string
  driveFolderUrl?: string | null
  driveFolderId?: string | null
}) {
  const [previewDoc, setPreviewDoc] = useState<ContactDocumentRecord | null>(null)
  const [uploading, setUploading] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [uploadType, setUploadType] = useState('Passport')
  const [uploadCategory, setUploadCategory] = useState('Contacts')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [ocrRunning, setOcrRunning] = useState<string | null>(null)
  const [folderAction, setFolderAction] = useState<'idle' | 'creating' | 'linking' | 'validating'>('idle')
  const [linkFolderId, setLinkFolderId] = useState('')
  const [validationResult, setValidationResult] = useState<{ valid: boolean; missingSubfolders: string[]; fileCount: number } | null>(null)
  const [showFileBrowser, setShowFileBrowser] = useState(false)

  const handleRunOcr = async (docId: string) => {
    setOcrRunning(docId)
    try {
      const res = await fetch('/api/crm/admin-actions/contact-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId, action: 'ocr_document', params: { document_id: docId } }),
      })
      const data = await res.json()
      if (data.success) {
        toast.success(data.detail)
        if (data.side_effects?.length) toast.info(data.side_effects.join(' | '))
        window.location.reload()
      } else {
        toast.error(data.detail || 'OCR failed')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setOcrRunning(null)
    }
  }

  const handleDeleteDoc = async (docId: string, fileName: string) => {
    if (!confirm(`Delete "${fileName}"? This will trash it on Drive and remove the record.`)) return
    setDeleting(docId)
    try {
      const res = await fetch('/api/crm/admin-actions/delete-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: docId }),
      })
      const data = await res.json()
      if (data.success) {
        toast.success(data.detail)
        window.location.reload()
      } else {
        toast.error(data.detail || 'Delete failed')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setDeleting(null)
    }
  }
  const accountMap = new Map(accounts.map(a => [a.id, a.company_name]))

  const handleFileUpload = async (file: File) => {
    setUploading(true)
    try {
      // Step 1: Upload to Supabase Storage (bypasses Vercel 4.5MB body limit)
      const storagePath = `crm-uploads/${contactId}/${Date.now()}_${file.name}`
      const uploadRes = await fetch(`/api/storage/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bucket: 'onboarding-uploads',
          path: storagePath,
          contentType: file.type,
        }),
      })
      const { signedUrl } = await uploadRes.json()

      if (!signedUrl) {
        toast.error('Failed to get upload URL')
        return
      }

      // Upload file directly to Supabase Storage via signed URL
      const storageUpload = await fetch(signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      })
      if (!storageUpload.ok) {
        toast.error('File upload failed')
        return
      }

      // Step 2: Call API with storage path (small JSON, no file in body)
      const res = await fetch('/api/crm/admin-actions/upload-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contactId,
          storage_path: storagePath,
          file_name: file.name,
          mime_type: file.type,
          document_type: uploadType,
          category: uploadCategory,
        }),
      })
      const data = await res.json()
      if (data.success) {
        toast.success(data.detail)
        if (data.side_effects?.length) toast.info(data.side_effects.join(' | '))
        setShowUpload(false)
        window.location.reload()
      } else {
        toast.error(data.detail || 'Upload failed')
      }
    } catch {
      toast.error('Upload error — check file size (max 50MB)')
    } finally {
      setUploading(false)
    }
  }

  // Group by canonical contact-side sections
  const getContactSection = (doc: ContactDocumentRecord): string => {
    const t = (doc.document_type_name || '').toLowerCase()
    if (/passport|id.doc|boi.report/i.test(t)) return 'Identity'
    if (/w-7|itin/i.test(t)) return 'ITIN'
    if (/1040|tax.return/i.test(t)) return 'Tax'
    return 'Other'
  }

  const grouped = documents.reduce<Record<string, ContactDocumentRecord[]>>((acc, doc) => {
    const section = getContactSection(doc)
    if (!acc[section]) acc[section] = []
    acc[section].push(doc)
    return acc
  }, {})

  const categoryOrder = ['Identity', 'ITIN', 'Tax', 'Other']
  const sortedCategories = categoryOrder.filter(c => grouped[c])

  const uploadButton = (
    <button
      onClick={() => setShowUpload(!showUpload)}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 transition-colors"
    >
      <Paperclip className="h-3.5 w-3.5" />
      Upload Document
    </button>
  )

  const uploadPanel = showUpload && (
    <div className="bg-white rounded-lg border p-4 space-y-3">
      <div className="flex items-center gap-3">
        <select
          value={uploadType}
          onChange={e => setUploadType(e.target.value)}
          className="text-sm border rounded-lg px-3 py-1.5 bg-white"
        >
          <option value="Passport">Passport</option>
          <option value="ID Document">ID Document</option>
          <option value="EIN Letter">EIN Letter</option>
          <option value="ITIN Letter">ITIN Letter</option>
          <option value="Articles of Organization">Articles of Organization</option>
          <option value="Operating Agreement">Operating Agreement</option>
          <option value="Bank Statement">Bank Statement</option>
          <option value="Tax Return">Tax Return</option>
          <option value="Other">Other</option>
        </select>
        <select
          value={uploadCategory}
          onChange={e => setUploadCategory(e.target.value)}
          className="text-sm border rounded-lg px-3 py-1.5 bg-white"
        >
          <option value="Contacts">Contacts</option>
          <option value="Company">Company</option>
          <option value="Tax">Tax</option>
          <option value="Banking">Banking</option>
          <option value="Correspondence">Correspondence</option>
        </select>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) handleFileUpload(f)
          }}
          disabled={uploading}
          className="flex-1 text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:font-medium file:cursor-pointer hover:file:bg-blue-100 disabled:opacity-50"
        />
        {uploading && <Loader2 className="h-4 w-4 animate-spin text-blue-600" />}
      </div>
      {uploadType === 'Passport' && (
        <p className="text-xs text-muted-foreground">Passport uploads are automatically OCR&apos;d to extract passport number and expiry date.</p>
      )}
    </div>
  )

  const handleCreateFolder = async () => {
    setFolderAction('creating')
    try {
      const { createContactFolder } = await import('@/app/(dashboard)/contacts/folder-actions')
      const result = await createContactFolder(contactId)
      if (result.success) {
        toast.success('Contact folder created')
        window.location.reload()
      } else {
        toast.error(result.error ?? 'Failed to create folder')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create folder')
    } finally {
      setFolderAction('idle')
    }
  }

  const handleLinkFolder = async () => {
    if (!linkFolderId.trim()) return
    setFolderAction('linking')
    try {
      const { linkContactFolder } = await import('@/app/(dashboard)/contacts/folder-actions')
      const result = await linkContactFolder(contactId, linkFolderId.trim())
      if (result.success) {
        toast.success('Drive folder linked')
        window.location.reload()
      } else {
        toast.error(result.error ?? 'Failed to link folder')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to link folder')
    } finally {
      setFolderAction('idle')
    }
  }

  const handleValidateFolder = async () => {
    setFolderAction('validating')
    try {
      const { validateContactFolder } = await import('@/app/(dashboard)/contacts/folder-actions')
      const result = await validateContactFolder(contactId)
      if (result.success && result.data) {
        setValidationResult(result.data)
      } else {
        toast.error(result.error ?? 'Validation failed')
      }
    } catch {
      toast.error('Validation failed')
    } finally {
      setFolderAction('idle')
    }
  }

  // Folder management section — shown when no folder is linked
  const folderCreateSection = !driveFolderId && (
    <div className="bg-white rounded-lg border p-6 text-center space-y-3">
      <FolderOpen className="h-7 w-7 mx-auto text-zinc-300" />
      <p className="text-sm text-zinc-400">No Drive folder linked to this contact</p>
      <div className="flex justify-center gap-2">
        <button
          onClick={handleCreateFolder}
          disabled={folderAction !== 'idle'}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {folderAction === 'creating' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
          Create Contact Folder
        </button>
      </div>
      <div className="max-w-xs mx-auto">
        <p className="text-xs text-zinc-400 mb-1.5">Or link an existing folder by ID:</p>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={linkFolderId}
            onChange={e => setLinkFolderId(e.target.value)}
            placeholder="Drive folder ID"
            className="flex-1 px-2 py-1 text-xs border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={handleLinkFolder}
            disabled={folderAction !== 'idle' || !linkFolderId.trim()}
            className="px-2 py-1 text-xs border rounded hover:bg-zinc-50 disabled:opacity-50"
          >
            Link
          </button>
        </div>
      </div>
    </div>
  )

  // File browser toggle — shown when folder IS linked
  const fileBrowserSection = driveFolderId && (
    <div className="space-y-2">
      {validationResult && (
        <div className={cn(
          'flex items-center gap-2 px-3 py-2 rounded-md text-sm',
          validationResult.valid ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
        )}>
          <ShieldCheck className="h-4 w-4 shrink-0" />
          {validationResult.valid
            ? `Folder valid — ${validationResult.fileCount} files`
            : `Missing subfolders: ${validationResult.missingSubfolders.join(', ')}`}
          <button onClick={() => setValidationResult(null)} className="ml-auto p-0.5 rounded hover:bg-white/50">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setShowFileBrowser(!showFileBrowser)}
          className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-700 px-2 py-1 rounded hover:bg-zinc-100"
        >
          <Folder className="h-3.5 w-3.5" />
          {showFileBrowser ? 'Hide' : 'Browse'} Drive Folder
        </button>
        <div className="flex items-center gap-1">
          <button
            onClick={handleValidateFolder}
            disabled={folderAction === 'validating'}
            className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-700 px-2 py-1 rounded hover:bg-zinc-100"
          >
            {folderAction === 'validating' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            Validate
          </button>
        </div>
      </div>
      {showFileBrowser && (
        <ContactFileBrowser contactId={contactId} driveFolderId={driveFolderId} />
      )}
    </div>
  )

  if (documents.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex justify-end gap-2">
          {driveFolderUrl && (
            <a
              href={driveFolderUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border bg-zinc-50 text-zinc-700 border-zinc-200 hover:bg-zinc-100 transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open in Drive
            </a>
          )}
          {uploadButton}
        </div>
        {uploadPanel}
        {folderCreateSection}
        {fileBrowserSection}
        {!driveFolderId && (
          <div className="bg-white rounded-lg border p-8 text-center text-sm text-muted-foreground">
            <FolderOpen className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No documents linked to this contact</p>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{documents.length} documents</p>
        <div className="flex items-center gap-2">
          {driveFolderUrl && (
            <a
              href={driveFolderUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border bg-zinc-50 text-zinc-700 border-zinc-200 hover:bg-zinc-100 transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open in Drive
            </a>
          )}
          {uploadButton}
        </div>
      </div>
      {fileBrowserSection}
      {uploadPanel}

      {sortedCategories.map(category => (
        <div key={category} className="space-y-2">
          <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
            {category} ({grouped[category].length})
          </h3>
          <div className="border rounded-lg divide-y">
            {grouped[category].map(doc => (
              <button
                key={doc.id}
                onClick={() => doc.drive_file_id ? setPreviewDoc(doc) : undefined}
                className={cn(
                  'flex items-center justify-between px-4 py-2.5 w-full text-left transition-colors',
                  doc.drive_file_id ? 'hover:bg-zinc-50 cursor-pointer' : 'opacity-60'
                )}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <span className="text-sm font-medium truncate block">{doc.file_name}</span>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {doc.document_type_name && <span>{doc.document_type_name}</span>}
                      {doc.file_size && <span>{formatFileSize(doc.file_size)}</span>}
                      {doc.processed_at && <span>{formatDate(doc.processed_at.split('T')[0])}</span>}
                      {doc.account_id && accountMap.get(doc.account_id) && (
                        <span className="text-blue-600">via {accountMap.get(doc.account_id)}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {doc.document_type_name && (
                    <span className={cn(
                      'text-xs px-2 py-0.5 rounded-full font-medium',
                      CATEGORY_COLORS[getContactSection(doc)] || 'bg-zinc-100 text-zinc-600'
                    )}>
                      {getContactSection(doc)}
                    </span>
                  )}
                  {doc.drive_file_id && (
                    <Eye className="h-4 w-4 text-muted-foreground" />
                  )}
                  {doc.drive_file_id && doc.document_type_name && /passport|itin|ein/i.test(doc.document_type_name) && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); handleRunOcr(doc.id) }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); handleRunOcr(doc.id) } }}
                      className={cn(
                        'p-1 rounded hover:bg-blue-50 text-zinc-400 hover:text-blue-600 transition-colors',
                        ocrRunning === doc.id && 'opacity-50 pointer-events-none'
                      )}
                      title="Run OCR"
                    >
                      {ocrRunning === doc.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    </span>
                  )}
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); handleDeleteDoc(doc.id, doc.file_name) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); handleDeleteDoc(doc.id, doc.file_name) } }}
                    className={cn(
                      'p-1 rounded hover:bg-red-50 text-zinc-400 hover:text-red-600 transition-colors',
                      deleting === doc.id && 'opacity-50 pointer-events-none'
                    )}
                  >
                    {deleting === doc.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}

      {/* Preview modal */}
      {previewDoc && previewDoc.drive_file_id && (
        <div className="fixed inset-0 z-50 bg-black/70 flex flex-col" onClick={() => setPreviewDoc(null)}>
          <div className="flex items-center justify-between px-6 py-3 bg-zinc-900 text-white shrink-0">
            <div className="flex items-center gap-3">
              <FileText className="h-4 w-4" />
              <span className="font-medium text-sm">{previewDoc.file_name}</span>
              {previewDoc.document_type_name && (
                <span className="text-xs text-zinc-400">{previewDoc.document_type_name}</span>
              )}
            </div>
            <button onClick={() => setPreviewDoc(null)} className="p-1 hover:bg-zinc-700 rounded">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex-1 p-4" onClick={e => e.stopPropagation()}>
            <iframe
              src={`/api/documents/${previewDoc.id}/preview`}
              className="w-full h-full rounded-lg bg-white"
              title={previewDoc.file_name}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Activity Tab ───

function ActivityTab({ conversations }: { conversations: ConversationEntry[] }) {
  if (conversations.length === 0) {
    return (
      <div className="bg-white rounded-lg border p-8 text-center text-sm text-muted-foreground">
        No conversation history
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {conversations.map(conv => (
        <div key={conv.id} className="bg-white rounded-lg border p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{conv.topic ?? 'Conversation'}</span>
              {conv.channel && (
                <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded', CHANNEL_COLORS[conv.channel] ?? 'bg-zinc-100 text-zinc-600')}>
                  {conv.channel}
                </span>
              )}
              {conv.direction && (
                <span className="text-xs text-muted-foreground">
                  {conv.direction === 'Inbound' ? '← In' : '→ Out'}
                </span>
              )}
            </div>
            <span className="text-xs text-muted-foreground">{formatDateTime(conv.created_at)}</span>
          </div>
          {conv.client_message && (
            <p className="text-sm text-zinc-700">{conv.client_message}</p>
          )}
          {conv.response_sent && (
            <p className="text-sm text-zinc-500 border-l-2 border-zinc-200 pl-3">{conv.response_sent}</p>
          )}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {conv.category && <span>{conv.category}</span>}
            {conv.handled_by && <span>by {conv.handled_by}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Invoices Tab ───

const INVOICE_STATUS_COLORS: Record<string, string> = {
  Paid: 'bg-emerald-100 text-emerald-700',
  Overdue: 'bg-red-100 text-red-700',
  Sent: 'bg-blue-100 text-blue-700',
  Draft: 'bg-zinc-100 text-zinc-600',
  Partial: 'bg-orange-100 text-orange-700',
  Cancelled: 'bg-zinc-100 text-zinc-500',
  Pending: 'bg-amber-100 text-amber-700',
}

function InvoicesTab({ invoices }: { invoices: ContactInvoice[] }) {
  const real = invoices.filter(i => i.invoice_number && i.invoice_number !== '1.0' && i.invoice_number !== '2.0')
  const legacy = invoices.filter(i => !i.invoice_number || i.invoice_number === '1.0' || i.invoice_number === '2.0')

  if (real.length === 0 && legacy.length === 0) {
    return <p className="text-sm text-muted-foreground">No invoices found</p>
  }

  const getCompany = (inv: ContactInvoice) =>
    (inv.accounts as unknown as { company_name: string })?.company_name ?? null

  const renderInvoiceRow = (inv: ContactInvoice) => {
    const status = inv.invoice_status ?? inv.status ?? '—'
    const total = Number(inv.total) || inv.amount || 0
    const curr = inv.amount_currency || 'USD'
    const company = getCompany(inv)
    const dateLabel = inv.paid_date ? 'Paid' : inv.due_date ? 'Due' : ''
    const dateVal = inv.paid_date ?? inv.due_date

    return (
      <div key={inv.id} className="grid grid-cols-1 md:grid-cols-[110px,1fr,100px,80px,100px,90px] gap-1 md:gap-3 px-4 py-2.5 border-b last:border-b-0 text-sm items-center">
        <span className="font-mono text-xs text-blue-600">{inv.invoice_number ?? '—'}</span>
        <div className="min-w-0">
          <p className="font-medium truncate">{inv.description ?? '—'}</p>
          {company && (
            <p className="text-xs text-muted-foreground truncate">
              <Building2 className="inline h-3 w-3 mr-1" />{company}
            </p>
          )}
          {!company && inv.contact_id && !inv.account_id && (
            <p className="text-xs text-muted-foreground">Personal (no company)</p>
          )}
        </div>
        <p className="text-right font-medium hidden md:block">
          {curr === 'EUR' ? '€' : '$'}{total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </p>
        <div className="hidden md:block">
          <span className={cn('text-xs px-1.5 py-0.5 rounded', INVOICE_STATUS_COLORS[status] ?? 'bg-zinc-100')}>
            {status}
          </span>
        </div>
        <p className="hidden md:block text-xs text-muted-foreground">
          {dateLabel} {dateVal ? format(parseISO(dateVal), 'MMM d, yyyy') : ''}
        </p>
        <p className="hidden md:block text-xs text-muted-foreground truncate">{inv.payment_method ?? '—'}</p>
      </div>
    )
  }

  const overdue = real.filter(i => (i.invoice_status ?? i.status) === 'Overdue')
  const pending = real.filter(i => ['Sent', 'Draft', 'Partial'].includes(i.invoice_status ?? i.status ?? ''))
  const paid = real.filter(i => (i.invoice_status ?? i.status) === 'Paid')
  const other = real.filter(i => !overdue.includes(i) && !pending.includes(i) && !paid.includes(i))

  return (
    <div className="space-y-6">
      {overdue.length > 0 && (
        <InvoiceGroup title="Overdue" items={overdue} color="text-red-600" renderRow={renderInvoiceRow} />
      )}
      {pending.length > 0 && (
        <InvoiceGroup title="Pending" items={pending} color="text-amber-600" renderRow={renderInvoiceRow} />
      )}
      {paid.length > 0 && (
        <InvoiceGroup title="Paid" items={paid} color="text-emerald-600" renderRow={renderInvoiceRow} defaultCollapsed />
      )}
      {other.length > 0 && (
        <InvoiceGroup title="Other" items={other} color="text-zinc-600" renderRow={renderInvoiceRow} defaultCollapsed />
      )}
      {legacy.length > 0 && (
        <InvoiceGroup title="Legacy (pre-invoice)" items={legacy} color="text-zinc-400" renderRow={renderInvoiceRow} defaultCollapsed />
      )}
    </div>
  )
}

function InvoiceGroup({
  title, items, color, renderRow, defaultCollapsed = false,
}: {
  title: string; items: ContactInvoice[]; color: string
  renderRow: (inv: ContactInvoice) => React.ReactNode; defaultCollapsed?: boolean
}) {
  const [open, setOpen] = useState(!defaultCollapsed)
  const total = items.reduce((sum, i) => sum + (Number(i.total) || i.amount || 0), 0)
  const curr = items[0]?.amount_currency || 'USD'

  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 w-full text-left py-2">
        <span className={cn('font-semibold text-sm uppercase tracking-wide', color)}>{title}</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600">{items.length}</span>
        <span className="text-xs text-muted-foreground ml-auto">
          {curr === 'EUR' ? '€' : '$'}{total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </button>
      {open && (
        <div className="bg-white rounded-lg border overflow-hidden">
          <div className="hidden md:grid md:grid-cols-[110px,1fr,100px,80px,100px,90px] gap-3 px-4 py-2 border-b bg-zinc-50 text-xs font-medium text-muted-foreground uppercase">
            <span>Invoice</span>
            <span>Description</span>
            <span className="text-right">Amount</span>
            <span>Status</span>
            <span>Date</span>
            <span>Method</span>
          </div>
          {items.map(renderRow)}
        </div>
      )}
    </div>
  )
}
