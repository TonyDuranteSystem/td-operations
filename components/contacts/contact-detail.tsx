'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, User, Mail, Phone, Globe, MapPin,
  Calendar, Shield, FileText, Briefcase, Clock,
  Building2, MessageSquare, KeyRound, CheckCircle2,
  Loader2, ChevronRight, Eye, EyeOff, X, FolderOpen, CreditCard,
  Stethoscope, Send, Zap, Bell, PlayCircle, Paperclip, Wand2, Sparkles, ScanText, Trash2,
  ChevronDown as ChevronDownIcon, ExternalLink, Folder, ShieldCheck, RefreshCw,
  Activity, Plus, GitBranch, Ban, Languages,
} from 'lucide-react'
import { InvoiceDialog, type InvoiceDialogDefaults } from '@/components/payments/invoice-dialog'
import { createInvoice } from '@/app/(dashboard)/payments/invoice-actions'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { ConfirmDestructiveDialog } from '@/components/ui/confirm-destructive-dialog'
import { BackendActivityPanel } from '@/components/shared/backend-activity-panel'
import { ClientConversationsPanel } from '@/components/conversations/client-conversations-panel'
import { ActivityFeed } from '@/components/accounts/activity-feed'
import { DeliveryRowActions } from '@/components/trackers/delivery-row-actions'
import { ComposeEmailButton } from '@/components/inbox/compose-email-button'
import { ThreadEmailPanel } from '@/components/portal-chats/thread-email-panel'
import { ChainAuditDialog } from '@/components/contacts/chain-audit-dialog'
import { MessageReactions } from '@/components/chat/message-reactions'
import type { MessageReaction } from '@/lib/portal/reactions'
import { ContactHealthPanel } from '@/components/contacts/contact-health-panel'
import { ReferralsGivenCard } from '@/components/referrals/referrals-given-card'
import { ConfirmPaymentDialog } from '@/app/(dashboard)/leads/[id]/components/confirm-payment-dialog'
import { AccountOfferPanel, type OfferData } from '@/components/offers/account-offer-panel'
import type { OfferPackageOption } from '@/lib/types/offer'
import { LlcNameSelectionCard } from '@/components/contacts/llc-name-selection-card'
import { ServiceDeliveriesSection, type ServiceDeliveryForStepper } from '@/components/accounts/service-deliveries-section'
import type { PipelineStage } from '@/components/accounts/sd-pipeline-stepper'
import { LifecycleTimeline } from '@/components/lifecycle/timeline'
import { assembleTimeline } from '@/lib/lifecycle-timeline'
import { isActivationEffectivelyPaid } from '@/lib/operations/activation-paid'
import { EditableField } from '@/components/accounts/editable-field'
import { EntityActivitySummary } from '@/components/dashboard/entity-activity-summary'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { updateContactField, addContactNote } from '@/app/(dashboard)/contacts/[id]/actions'
import { updateAccountContactRole, toggleDocumentPortalVisibility } from '@/app/(dashboard)/accounts/actions'
import { OcrViewerModal } from '@/components/documents/ocr-viewer'
import { format, parseISO } from 'date-fns'
import type { LinkedAccount, ServiceDelivery, ConversationEntry, ChatAttachment } from '@/lib/types'
import { uploadChatAttachment, validateChatAttachment } from '@/lib/portal/chat-attachment'
import { FlowChips } from '@/components/flows/flow-chips'
import type { ResolvedFlow } from '@/lib/flows/resolve-flows'

// ─── Constants ───

const TABS = [
  { key: 'overview', label: 'Overview', icon: User, tooltip: 'Contact details, linked accounts, and offer history.' },
  { key: 'services', label: 'Services', icon: Briefcase, tooltip: 'Active service deliveries for this client — formations, annual reports, etc.' },
  { key: 'invoices', label: 'Invoices', icon: CreditCard, tooltip: 'All invoices and payment history for this client.' },
  { key: 'documents', label: 'Documents', icon: FolderOpen, tooltip: 'Uploaded files — IDs, contracts, certificates, and more.' },
  { key: 'emails', label: 'Emails', icon: Mail, tooltip: 'All Gmail with this contact — auto-matched by their addresses plus manually linked emails.' },
  { key: 'chat', label: 'Chat', icon: MessageSquare, tooltip: 'All communication — portal messages and email threads in one timeline.' },
  { key: 'portal', label: 'Portal', icon: KeyRound, tooltip: 'Client portal access — login status, tier, and portal settings.' },
  { key: 'health', label: 'Health', icon: Stethoscope, tooltip: 'One-screen view of every audit check for this contact — diagnostic + chain audit together.' },
  { key: 'activity', label: 'Activity', icon: MessageSquare, tooltip: 'Account communications timeline — grouped by channel.' },
  { key: 'conversations', label: 'Conversations', icon: MessageSquare, tooltip: 'Slack client conversations tagged to this contact — topic, date, and the full thread.' },
  { key: 'journey', label: 'Journey', icon: GitBranch, tooltip: 'Full client journey — offers, payments, activations, services, wizards, documents, tasks, and portal messages in one feed.' },
  { key: 'backend', label: 'Backend', icon: Activity, tooltip: 'Read-only view of CRM actions, background jobs, webhook events, and session checkpoints that touched this contact.' },
]

const TIER_COLORS: Record<string, string> = {
  lead: 'bg-zinc-100 text-zinc-600',
  formation: 'bg-purple-100 text-purple-700',
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
  address_line1: string | null
  address_city: string | null
  address_state: string | null
  address_zip: string | null
  address_country: string | null
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
  suspended: boolean
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
  portal_visible: boolean | null
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
  view_count: number
  required_documents: unknown
  created_at: string
  viewed_at: string | null
  expires_at: string | null
  packages: OfferPackageOption[] | null
  selected_package_key: string | null
  package_locked_at: string | null
}

interface PendingActivationRecord {
  id: string
  offer_token: string | null
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
  stepperDeliveries?: ServiceDeliveryForStepper[]
  stagesByServiceType?: Record<string, PipelineStage[]>
  /** Contact-scoped flows (ITIN, …) — rendered as flow chips. */
  flows?: ResolvedFlow[]
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
  stepperDeliveries = [],
  stagesByServiceType = {},
  flows = [],
}: ContactDetailProps) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState('overview')
  const [showChainAudit, setShowChainAudit] = useState(false)
  const [showDeleteContact, setShowDeleteContact] = useState(false)
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
              <EditableField
                label=""
                value={contact.full_name}
                className="text-2xl font-bold"
                onSave={makeContactSaver('full_name')}
              />
              {portalAuth.suspended ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded bg-red-100 text-red-700">
                  <Ban className="h-3 w-3" /> Suspended
                </span>
              ) : contact.portal_tier ? (
                <span className={cn('text-xs font-medium px-2 py-0.5 rounded', TIER_COLORS[contact.portal_tier] ?? 'bg-zinc-100')}>
                  {contact.portal_tier}
                </span>
              ) : null}
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
          <button
            onClick={() => setShowDeleteContact(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-red-50 text-red-700 hover:bg-red-100 transition-colors"
            title="Delete this contact (orphans with no linked history) or merge it into the real contact."
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete / Merge
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

      {/* Pipeline Stepper — click-to-advance for contact-only SDs (ITIN post Phase 1). */}
      {stepperDeliveries.length > 0 && (
        <ServiceDeliveriesSection
          deliveries={stepperDeliveries}
          stagesByServiceType={stagesByServiceType}
          title="Contact-Level Service Deliveries"
          emptyMessage="No contact-level service deliveries (ITIN, etc.)."
        />
      )}

      {/* Lifecycle Timeline */}
      <LifecycleTimeline events={timelineEvents} defaultOpen={false} />

      {/* Notification Center roll-up: What's New + To-Do + Workflow for this contact */}
      <EntityActivitySummary contactId={contact.id} />

      {/* Referrals GIVEN by this person (or their companies) — renders only when there are any */}
      <ReferralsGivenCard contactId={contact.id} />

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
        />
      )}
      {activeTab === 'services' && (
        <div className="space-y-6">
          {flows.length > 0 && <FlowChips flows={flows} />}
          <ServicesTab serviceDeliveries={serviceDeliveries} accounts={accounts} contactId={contact.id} />
        </div>
      )}
      {activeTab === 'invoices' && (
        <InvoicesTab invoices={invoices} accounts={accounts} />
      )}
      {activeTab === 'documents' && (
        <ContactDocumentsTab documents={documents} accounts={accounts} contactId={contact.id} driveFolderUrl={contact.gdrive_folder_url} driveFolderId={contact.drive_folder_id} />
      )}
      {activeTab === 'emails' && (
        // All Gmail with this contact: auto-matched + manually linked
        // (email_links). Same panel as Portal Chats / account page.
        <div className="flex h-[70vh] min-h-[420px] border rounded-lg overflow-hidden bg-white">
          <ThreadEmailPanel accountId={null} contactId={contact.id} />
        </div>
      )}
      {activeTab === 'chat' && (
        <ChatTab contactId={contact.id} onUnreadChange={setChatUnread} />
      )}
      {activeTab === 'portal' && (
        <PortalTab contact={contact} portalAuth={portalAuth} accounts={accounts} />
      )}
      {activeTab === 'health' && (
        <ContactHealthPanel contactId={contact.id} contactName={contact.full_name} />
      )}
      {activeTab === 'activity' && (
        <ActivityTab conversations={conversations} />
      )}
      {activeTab === 'conversations' && (
        <ClientConversationsPanel entityType="contact" entityId={contact.id} />
      )}
      {activeTab === 'journey' && (
        <ActivityFeed kind="contact" contactId={contact.id} accountIds={accounts.map((a) => a.id)} />
      )}
      {activeTab === 'backend' && (
        <BackendActivityPanel kind="contact" contactId={contact.id} email={contact.email} />
      )}

      <ChainAuditDialog
        open={showChainAudit}
        onClose={() => setShowChainAudit(false)}
        contactId={contact.id}
        contactName={contact.full_name}
      />

      <ConfirmDestructiveDialog
        open={showDeleteContact}
        onClose={() => setShowDeleteContact(false)}
        title="Delete contact"
        description={`Remove "${contact.full_name}" from the CRM. A contact with ANY linked history can't be hard-deleted — the preview below will tell you to merge it into the real contact instead.`}
        severity="red"
        requireTypeToConfirm="DELETE"
        confirmLabel="Delete contact"
        loadPreview={async () => {
          const res = await fetch('/api/crm/admin-actions/delete-contact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contact_id: contact.id, dry_run: true }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(data.error || 'Failed to load delete preview')
          return data.preview
        }}
        onConfirm={async () => {
          const res = await fetch('/api/crm/admin-actions/delete-contact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contact_id: contact.id, mode: 'delete' }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) return { success: false, error: data.error || 'Delete failed' }
          return { success: true, message: data.message }
        }}
        onSuccess={() => router.push('/contacts')}
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
}: {
  contact: ContactRecord
  accounts: LinkedAccount[]
  lead: LeadOrigin | null
  makeContactSaver: (field: string) => (value: string) => Promise<{ success: boolean; error?: string }>
  offers: OfferRecord[]
  pendingActivations: PendingActivationRecord[]
  wizardProgress: WizardProgressRecord[]
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
        <EditableField icon={MapPin} label="Address" value={contact.address_line1 ?? ''} onSave={makeContactSaver('address_line1')} />
        <EditableField icon={MapPin} label="City" value={contact.address_city ?? ''} onSave={makeContactSaver('address_city')} />
        <EditableField icon={MapPin} label="State / Province" value={contact.address_state ?? ''} onSave={makeContactSaver('address_state')} />
        <EditableField icon={MapPin} label="ZIP / Postal Code" value={contact.address_zip ?? ''} onSave={makeContactSaver('address_zip')} />
        <EditableField icon={MapPin} label="Country" value={contact.address_country ?? ''} onSave={makeContactSaver('address_country')} />
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
              <div key={acc.id} className="rounded-lg border overflow-hidden">
                <Link
                  href={`/accounts/${acc.id}`}
                  className="flex items-center justify-between p-3 hover:bg-zinc-50 transition-colors group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{acc.company_name}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {acc.entity_type && <span>{acc.entity_type === 'Single Member LLC' ? 'SMLLC' : acc.entity_type === 'Multi Member LLC' ? 'MMLLC' : acc.entity_type}</span>}
                        {acc.state_of_formation && <span>· {acc.state_of_formation}</span>}
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
                <div className="px-3 pb-3 pt-0 border-t bg-zinc-50/50">
                  <EditableField
                    label="Role"
                    value={acc.role ?? ''}
                    type="select"
                    options={[
                      { label: '—', value: '' },
                      { label: 'Owner / Sole Member', value: 'owner' },
                      { label: 'Authorized Representative', value: 'authorized_representative' },
                      { label: 'Manager', value: 'manager' },
                      { label: 'Accountant', value: 'accountant' },
                    ]}
                    onSave={async (value) => {
                      const result = await updateAccountContactRole(acc.id, contact.id, value)
                      if (result.success) toast.success('Role updated')
                      else toast.error(result.error ?? 'Failed')
                      return result
                    }}
                  />
                </div>
              </div>
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
      <OfferStatusCard
        offers={offers}
        contactId={contact.id}
        contactName={contact.full_name ?? ''}
        contactEmail={contact.email ?? ''}
        contactLanguage={contact.language}
        pendingActivations={pendingActivations}
      />

      {/* Wizard Progress Card */}
      <WizardProgressCard wizardProgress={wizardProgress} pendingActivations={pendingActivations} contactId={contact.id} contactHasDriveFolder={!!contact.gdrive_folder_url} />

      {/* LLC Name Selection Card */}
      <LlcNameSelectionCard
        wizardProgress={wizardProgress}
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
  // Resend credentials is available for ANY client who has a portal login —
  // NOT just those who never logged in. Staff must be able to send a new
  // password whenever a client forgets it or something goes wrong.
  const showResendCredentials = portalAuth.exists
  const portalCredsSentAt = (contact as { portal_email_sent_at?: string | null }).portal_email_sent_at ?? null
  const showWizardReminder = contact.portal_tier === 'onboarding' && !hasWizard && (hasPaidOffer || pendingActivations.some(pa => pa.payment_confirmed_at))
  const showAdvanceStage = activeSds.length > 0
  const awaitingPayment = pendingActivations.find(pa => pa.status === 'awaiting_payment')
  // Show the button when an offer is awaiting payment AND we have either a
  // lead (classic funnel) OR a signed offer in scope (existing-account /
  // existing-contact re-entry, e.g. Mojo Labs LLC).
  const showConfirmPaymentBtn = !!awaitingPayment && (!!lead || offers.length > 0)

  const hasActions = showCreatePortal || showResendCredentials || showWizardReminder || showAdvanceStage || showConfirmPaymentBtn

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

        {showResendCredentials && (
          <div className="flex flex-col gap-1">
            <button
              onClick={() => {
                if (!confirm('Send the client a NEW temporary password? Their current password will stop working.')) return
                handlePortalAction('reset_password')
              }}
              disabled={loading === 'reset_password'}
              className="inline-flex items-center gap-1.5 self-start px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 disabled:opacity-50 transition-colors"
            >
              {loading === 'reset_password' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
              Send new password
            </button>
            <p className="max-w-xs text-[11px] leading-snug text-zinc-500">
              {portalCredsSentAt
                ? `Welcome email with login details was sent on ${new Date(portalCredsSentAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}. `
                : 'No original credentials email is on record. '}
              This sends a <strong>new temporary password</strong> only — the old password stops working and the client sets their own at next login.
            </p>
          </div>
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

      {/* Confirm Payment Dialog
          Two paths:
            - Lead in scope: pass leadId (existing behavior)
            - No lead, but contact has a signed offer: pass contactId +
              offerToken (account/contact re-entry case, e.g. Mojo Labs LLC).
              The server-side route resolves account_id from offer.account_id. */}
      {showConfirmPayment && (lead || offers[0]) && (
        <ConfirmPaymentDialog
          open={showConfirmPayment}
          onClose={() => setShowConfirmPayment(false)}
          leadId={lead?.id}
          contactId={lead ? undefined : contact.id}
          offerToken={lead ? undefined : offers[0]?.token}
          clientName={contact.full_name ?? lead?.full_name ?? 'Client'}
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

  // Formation stage ordering (8-stage v2 pipeline) for the "beyond the initial
  // data/review phase" check (i.e. the company is actually being filed onward).
  const FORMATION_STAGE_ORDER = [
    'Payment Confirmed', 'Wizard Submitted', 'Filed with State', 'Articles Received',
    'SS-4 Prepared', 'SS-4 Signed', 'SS-4 Sent to IRS', 'EIN Received',
  ]

  const formationBeyondDataCollection = formationSds.some(sd => {
    const idx = FORMATION_STAGE_ORDER.indexOf(sd.stage ?? '')
    return idx > 1 // anything after Wizard Submitted (Filed with State onward)
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
  if (primaryActivation && isActivationEffectivelyPaid(primaryActivation)) {
    // Paid iff payment_confirmed_at is set, OR the service is activated and it
    // was NOT the deliberately payment-decoupled "Activate Now" path. Fixes
    // activated-but-unstamped rows showing "Awaiting Payment" forever (e.g. a
    // bank-transfer activation that missed the timestamp — Michele Cotti,
    // 2026-06-10). Single rule in lib/operations/activation-paid.ts.
    paidStep = { label: 'Paid', status: 'done', detail: primaryActivation.payment_method ?? undefined }
  } else if (signedStep.status === 'done') {
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
    if (primaryFormation.stage === 'EIN Received' || primaryFormation.status === 'completed') {
      serviceStep = { label: 'Service', status: 'done', detail: 'Formation complete' }
    } else if (formationBeyondDataCollection) {
      serviceStep = { label: 'Service', status: 'current', detail: primaryFormation.stage ?? undefined }
    } else if (primaryFormation.stage === 'Payment Confirmed') {
      serviceStep = { label: 'Service', status: 'current', detail: 'Payment Confirmed' }
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
  contactId,
  contactName,
  contactEmail,
  contactLanguage,
  pendingActivations = [],
}: {
  offers: OfferRecord[]
  contactId: string
  contactName: string
  contactEmail: string
  contactLanguage?: string | null
  pendingActivations?: PendingActivationRecord[]
}) {
  const primaryOffer = offers.find(o => o.status !== 'draft') ?? offers[0] ?? null

  // Spread rather than list every field by hand: primaryOffer already carries
  // everything OfferData needs (plus a few extras this panel doesn't use,
  // which spreading through is harmless). A field-by-field copy is exactly
  // the pattern that silently dropped packages/selected_package_key/
  // package_locked_at the first time this was wired up (found by adversarial
  // review) — spreading means a FUTURE new field reaches the panel without
  // this file needing to be remembered and touched again. Only the two
  // fields OfferRecord types as `unknown` need an explicit cast.
  const offerData: OfferData | null = primaryOffer ? {
    ...primaryOffer,
    view_count: primaryOffer.view_count ?? 0,
    cost_summary: primaryOffer.cost_summary as OfferData['cost_summary'],
    required_documents: primaryOffer.required_documents as OfferData['required_documents'],
  } : null

  // Always pre-populate with the person's name — staff can edit it in the dialog
  // before creating. The company name is irrelevant for individual services (ITIN etc.)
  const companyName = contactName
  // Offers created from a CONTACT page are for the PERSON — never attached to one
  // of their companies. To sell a service for a specific company, create the offer
  // from that company's page. (Antonio's model: the launch context is the subject.)
  // dev_task 262be11c.
  const accountId = null

  // Match this offer's activation (by offer token) so the panel can show
  // "Activate now" vs the persistent "Activated · payment pending" reminder.
  const offerActivation = offerData
    ? (pendingActivations.find(a => a.offer_token === offerData.token) ?? null)
    : null

  return (
    <div className="space-y-2">
      <AccountOfferPanel
        accountId={accountId}
        companyName={companyName}
        clientEmail={contactEmail}
        clientLanguage={contactLanguage}
        contactId={contactId}
        offer={offerData}
        isAdmin={true}
        pendingActivation={offerActivation}
      />
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
  attachments?: ChatAttachment[] | null
  read_at: string | null
  created_at: string
  source: string
  reactions?: MessageReaction[] | null
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
  const [pendingFiles, setPendingFiles] = useState<Array<{ file: File }>>([])
  const MAX_ATTACHMENTS_STAFF = 5
  const [error, setError] = useState<string | null>(null)
  const [notifOpen, setNotifOpen] = useState(false)
  const [polishing, setPolishing] = useState(false)
  // AI Polish defaults to matching the client's language on file (unchanged
  // behavior) — lets staff opt out for one message. Dev job 9c251e65.
  const [preserveLanguage, setPreserveLanguage] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  // Cross-border advisory notes (dev job 09cc3aec) — INTERNAL ONLY, never
  // auto-inserted into draft. Same contract as the Portal Chats page.
  const [crossBorderNotes, setCrossBorderNotes] = useState<{ lens: string; label: string; status: string; text: string }[]>([])
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

  const handleFileSelect = (file: File) => {
    const validationError = validateChatAttachment(file.name, file.size, file.type)
    if (validationError) {
      toast.error(validationError)
      return
    }
    setPendingFiles(prev => {
      if (prev.length >= MAX_ATTACHMENTS_STAFF) {
        toast.error(`Maximum ${MAX_ATTACHMENTS_STAFF} files per message.`)
        return prev
      }
      return [...prev, { file }]
    })
  }

  const handleSend = async () => {
    if ((!draft.trim() && pendingFiles.length === 0) || sending) return
    setSending(true)
    const filesToSend = pendingFiles
    const msg = draft.trim()
    setDraft('')
    setCrossBorderNotes([])
    setPendingFiles([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    try {
      let uploaded: ChatAttachment[] = []
      if (filesToSend.length > 0) {
        setUploading(true)
        try {
          uploaded = await Promise.all(filesToSend.map((pf) =>
            uploadChatAttachment(pf.file, { contactId })
          ))
        } finally {
          setUploading(false)
        }
      }
      const res = await fetch('/api/portal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contactId,
          message: msg,
          attachments: uploaded,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      await fetchMessages()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to send')
      setDraft(msg)
    } finally {
      setSending(false)
    }
  }

  // Polish couldn't tell what language to use (nothing from the client to read
  // yet, or it's too short/ambiguous) — Antonio, 2026-08-22: ask, don't guess.
  const [polishAskLanguage, setPolishAskLanguage] = useState(false)

  const handlePolish = async (explicitLanguage?: string) => {
    if (!draft.trim() || polishing) return
    setPolishing(true)
    try {
      const res = await fetch('/api/portal/chat/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Was sending { text: draft } with no contact_id — the route expects
        // `message` and needs the client's id to know their language on file, so
        // this call always 400'd and never actually translated (dev job 9c251e65).
        body: JSON.stringify({
          message: draft,
          contact_id: contactId,
          preserve_language: preserveLanguage,
          ...(explicitLanguage ? { target_language: explicitLanguage } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Polish failed')
      if (data.needs_language_choice) {
        setPolishAskLanguage(true)
        return
      }
      setPolishAskLanguage(false)
      if (data.polished) {
        setDraft(data.polished)
        toast.success(data.applied_language ? `Polished — translated to ${data.applied_language}` : 'Polished — language kept as written')
      }
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'AI polish failed')
    } finally {
      setPolishing(false)
    }
  }

  const handleSuggest = async () => {
    if (suggesting) return
    setSuggesting(true)
    setCrossBorderNotes([])
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
      setCrossBorderNotes(Array.isArray(data.crossBorderNotes) ? data.crossBorderNotes : [])
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
                        {(() => {
                          const atts: ChatAttachment[] = msg.attachments?.length
                            ? msg.attachments
                            : msg.attachment_url
                            ? [{ url: msg.attachment_url, name: msg.attachment_name || 'Attachment' }]
                            : []
                          if (atts.length === 0) return null
                          return (
                            <div className="mt-1 space-y-1">
                              {atts.map((att, i) => (
                                <a
                                  key={i}
                                  href={att.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                                >
                                  <FileText className="h-3 w-3 shrink-0" />
                                  <span className="truncate max-w-[200px]">{att.name}</span>
                                  {att.size && <span className="text-zinc-400">({formatFileSize(att.size)})</span>}
                                </a>
                              ))}
                            </div>
                          )
                        })()}
                        <p className="text-[10px] text-zinc-400 mt-1">
                          {formatDateTime(msg.created_at)}
                        </p>
                        <div className="mt-1">
                          <MessageReactions
                            messageId={msg.id}
                            reactions={msg.reactions}
                            viewerReactorId={null}
                            align={msg.sender_type === 'admin' ? 'right' : 'left'}
                            staffLabel="Team"
                            onReacted={fetchMessages}
                          />
                        </div>
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
        {pendingFiles.length > 0 && (
          <div className="mx-3 mb-2 flex flex-wrap gap-2 p-2 bg-blue-50 rounded-lg">
            {pendingFiles.map((pf, i) => (
              <div key={i} className="flex items-center gap-1.5 bg-white border border-blue-200 rounded-lg px-2 py-1 text-xs max-w-[180px] group">
                <FileText className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                <span className="truncate text-blue-700">{pf.file.name}</span>
                <span className="text-blue-400 shrink-0">{formatFileSize(pf.file.size)}</span>
                <button
                  onClick={() => setPendingFiles(prev => prev.filter((_, idx) => idx !== i))}
                  className="text-blue-400 hover:text-blue-600 shrink-0 ml-auto"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Cross-border advisory notes (dev job 09cc3aec) — INTERNAL ONLY,
            visibly marked so staff never mistake this for client-ready text. */}
        {crossBorderNotes.length > 0 && (
          <div className="mx-3 mb-2 rounded-lg border-2 border-amber-400 bg-amber-50 p-2.5">
            <p className="text-[10px] font-bold text-amber-800 uppercase tracking-wide mb-1.5">
              ⚠ Internal only — verify with a local professional before saying this to the client
            </p>
            {crossBorderNotes.map((note) => (
              <div key={note.lens} className="mb-1.5 last:mb-0">
                <p className="text-[11px] font-semibold text-amber-700">{note.label}</p>
                {note.status === 'error' ? (
                  <p className="text-xs text-amber-600 italic">Check unavailable — try again.</p>
                ) : (
                  <p className="text-xs text-amber-900 whitespace-pre-wrap">{note.text}</p>
                )}
              </div>
            ))}
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
                pendingFiles.length > 0
                  ? 'text-blue-600 bg-blue-100 hover:bg-blue-200'
                  : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 disabled:opacity-50'
              )}
            >
              {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Paperclip className="h-5 w-5" />}
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              onChange={e => { Array.from(e.target.files ?? []).forEach(f => handleFileSelect(f)) }}
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
            {/* Polish couldn't tell what language to use — ask, don't guess.
                Replaces the toggle+wand until staff pick one. */}
            {draft.trim() && polishAskLanguage ? (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => handlePolish('English')}
                  disabled={polishing}
                  className="px-2 py-1.5 rounded-full text-xs font-medium bg-violet-100 text-violet-700 hover:bg-violet-200 disabled:opacity-50 transition-colors"
                >
                  English
                </button>
                <button
                  onClick={() => handlePolish('Italian')}
                  disabled={polishing}
                  className="px-2 py-1.5 rounded-full text-xs font-medium bg-violet-100 text-violet-700 hover:bg-violet-200 disabled:opacity-50 transition-colors"
                >
                  Italian
                </button>
                <button
                  onClick={() => setPolishAskLanguage(false)}
                  className="p-1.5 rounded-full text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
                  title="Cancel"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <>
                {/* Language toggle for AI Polish — off (default) matches whatever
                    language the client is actually writing in this conversation,
                    on keeps the draft exactly as written. */}
                {draft.trim() && (
                  <button
                    onClick={() => setPreserveLanguage(v => !v)}
                    className={cn(
                      'p-2 rounded-full transition-colors shrink-0',
                      preserveLanguage
                        ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                        : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100'
                    )}
                    title={preserveLanguage ? 'Polish will keep the language as written — click to match the client instead' : 'Polish will match the language the client is writing — click to keep it as written instead'}
                  >
                    <Languages className="h-5 w-5" />
                  </button>
                )}
                {/* AI Polish — appears when text typed */}
                {draft.trim() && (
                  <button
                    onClick={() => handlePolish()}
                    disabled={polishing}
                    className="p-2 rounded-full bg-violet-100 text-violet-600 hover:bg-violet-200 disabled:opacity-50 transition-colors shrink-0"
                    title={preserveLanguage ? 'AI Polish — clean up grammar, keep language as written' : 'AI Polish — clean up grammar and match the client\'s language'}
                  >
                    {polishing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wand2 className="h-5 w-5" />}
                  </button>
                )}
              </>
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
            ) : (draft.trim() || pendingFiles.length > 0) ? (
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
  const accountMap = new Map(accounts.map(a => [a.id, a.company_name]))
  const [addOpen, setAddOpen] = useState(false)
  const existingTypes = serviceDeliveries
    .filter(sd => sd.status !== 'cancelled' && sd.status !== 'completed')
    .map(sd => sd.service_type)
    .filter((t): t is string => !!t)

  if (serviceDeliveries.length === 0) {
    return (
      <>
        <div className="bg-white rounded-lg border p-8 text-center text-sm text-muted-foreground">
          <p className="mb-3">No service deliveries found</p>
          <button
            onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-zinc-900 text-white text-sm hover:bg-zinc-800"
          >
            <Plus className="h-3.5 w-3.5" /> Add Service
          </button>
        </div>
        <ContactAddServiceDialog open={addOpen} onClose={() => setAddOpen(false)} contactId={contactId} existingTypes={existingTypes} />
      </>
    )
  }

  return (
    <div className="bg-white rounded-lg border overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b bg-zinc-50">
        <h3 className="text-sm font-semibold text-zinc-700">Service Deliveries</h3>
        <button
          onClick={() => setAddOpen(true)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-zinc-900 text-white text-xs hover:bg-zinc-800"
        >
          <Plus className="h-3 w-3" /> Add Service
        </button>
      </div>
      <ContactAddServiceDialog open={addOpen} onClose={() => setAddOpen(false)} contactId={contactId} existingTypes={existingTypes} />
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
            <DeliveryRowActions delivery={{
              id: sd.id,
              service_name: sd.service_name ?? null,
              service_type: sd.service_type ?? null,
              status: sd.status ?? null,
              stage: sd.stage ?? null,
              assigned_to: sd.assigned_to ?? null,
              notes: sd.notes ?? null,
              updated_at: sd.updated_at,
            }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Contact Add Service Dialog ───
// Mirror of the account-page Add Service dialog but creates a contact-level
// SD instead of an account-level one. Pulls service options from the catalog
// filtered to services tagged 'contact_eligible' (catalog framework). Adding
// a new contact-eligible service tomorrow = one INSERT to catalog_entries
// tags, zero code change here.

interface ContactServiceOption { id: string; name: string; pipeline: string | null }

function ContactAddServiceDialog({ open, onClose, contactId, existingTypes }: {
  open: boolean; onClose: () => void; contactId: string; existingTypes: string[]
}) {
  const router = useRouter()
  const [serviceType, setServiceType] = useState('')
  const [notes, setNotes] = useState('')
  const [creating, setCreating] = useState(false)
  const [skipInvoice, setSkipInvoice] = useState(false)
  const [options, setOptions] = useState<ContactServiceOption[]>([])
  const [loadingOptions, setLoadingOptions] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadingOptions(true)
    fetch('/api/service-catalog?contact_eligible=true')
      .then(r => r.json())
      .then(data => {
        if (cancelled) return
        const list = (data.services ?? []) as Array<ContactServiceOption & { active?: boolean }>
        const filtered = list
          .filter(s => s.active !== false && typeof s.pipeline === 'string' && s.pipeline.trim().length > 0)
          .map(s => ({ id: s.id, name: s.name, pipeline: s.pipeline }))
          .sort((a, b) => a.name.localeCompare(b.name))
        setOptions(filtered)
      })
      .catch(() => { if (!cancelled) toast.error('Failed to load service catalog') })
      .finally(() => { if (!cancelled) setLoadingOptions(false) })
    return () => { cancelled = true }
  }, [open])

  if (!open) return null

  const handleCreate = async () => {
    if (!serviceType) { toast.error('Select a service type'); return }
    setCreating(true)
    const res = await fetch('/api/crm/admin-actions/create-service', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_id: contactId, service_type: serviceType, notes: notes.trim() || undefined, skip_invoice: skipInvoice }),
    })
    const data = await res.json()
    setCreating(false)
    if (data.success) {
      toast.success(skipInvoice
        ? `${serviceType} created (no invoice) — workflow + topic auto-spawned in portal-chats`
        : `${serviceType} created — workflow + topic auto-spawned in portal-chats`)
      setServiceType('')
      setNotes('')
      setSkipInvoice(false)
      onClose()
      router.refresh()
    } else {
      toast.error(data.error ?? 'Failed to create service')
    }
  }

  const handleClose = () => { setServiceType(''); setNotes(''); setSkipInvoice(false); onClose() }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={handleClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <h2 className="text-lg font-semibold">Add Service (Contact-level)</h2>
            <button onClick={handleClose} className="p-1 rounded hover:bg-zinc-100"><X className="h-5 w-5" /></button>
          </div>
          <div className="px-6 py-4 space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Service Type *</label>
              <select
                value={serviceType}
                onChange={e => setServiceType(e.target.value)}
                disabled={loadingOptions}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-zinc-50"
              >
                <option value="">{loadingOptions ? 'Loading…' : 'Select…'}</option>
                {options.map(opt => {
                  const value = opt.pipeline ?? opt.name
                  const exists = existingTypes.includes(value)
                  return (
                    <option key={opt.id} value={value} disabled={exists}>
                      {opt.name}{exists ? ' (exists)' : ''}
                    </option>
                  )
                })}
              </select>
              {!loadingOptions && options.length === 0 && (
                <p className="mt-1 text-xs text-amber-700">
                  No contact-eligible services in the catalog. Tag a service with `contact_eligible` first.
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Notes</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                placeholder="Optional notes…"
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={skipInvoice} onChange={e => setSkipInvoice(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-zinc-300" />
              <span>
                Already paid — don&apos;t create an invoice
                <span className="block text-xs text-muted-foreground">Tick this when the service was already paid (e.g. ITIN bundled into a formation offer). Otherwise a draft invoice is auto-created.</span>
              </span>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={handleClose} className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50">Cancel</button>
              <button onClick={handleCreate} disabled={creating || !serviceType}
                className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2">
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Create
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Portal Tab ───

function PortalTab({
  contact,
  portalAuth,
  accounts,
}: {
  contact: ContactRecord
  portalAuth: PortalAuth
  accounts: LinkedAccount[]
}) {
  const [loading, setLoading] = useState<string | null>(null)
  const [tier, setTier] = useState(contact.portal_tier ?? '')
  const [portalExists, setPortalExists] = useState(portalAuth.exists)
  const [suspended, setSuspended] = useState(portalAuth.suspended)
  const [revokedAccountIds, setRevokedAccountIds] = useState<Set<string>>(new Set())

  const memberAccounts = accounts.filter(a => a.role === 'Member')

  // Suspend blocks the person's portal LOGIN entirely (one login per email),
  // so the confirm dialog lists every company they can reach — the full blast
  // radius — before the admin commits.
  const handleSuspendToggle = async (action: 'suspend' | 'unsuspend') => {
    if (action === 'suspend') {
      const companyList = accounts.length > 0
        ? `\n\nThis blocks their login to ALL of these companies:\n• ${accounts.map(a => a.company_name).join('\n• ')}`
        : ''
      if (!confirm(`Suspend ${contact.full_name}'s portal login?${companyList}\n\nThey will be unable to log in and will receive a suspension email.`)) return
    } else {
      if (!confirm(`Restore ${contact.full_name}'s portal login? They will be able to log in again and will receive a restoration email.`)) return
    }
    setLoading(action)
    try {
      const res = await fetch('/api/crm/admin-actions/contact-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, contact_id: contact.id }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(data.message)
        setSuspended(action === 'suspend')
        setTimeout(() => window.location.reload(), 1200)
      } else {
        toast.error(data.error ?? 'Failed')
      }
    } catch {
      toast.error('Request failed')
    } finally {
      setLoading(null)
    }
  }

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
        if (action === 'revoke_access' && extra?.account_id) {
          setRevokedAccountIds(prev => { const s = new Set(Array.from(prev)); s.add(extra.account_id); return s })
        }
        if (action === 'restore_access' && extra?.account_id) {
          setRevokedAccountIds(prev => { const s = new Set(Array.from(prev)); s.delete(extra.account_id); return s })
        }
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

  const handleCleanupLogins = async () => {
    setLoading('cleanup_logins')
    try {
      // Preview first (dry run) so the operator sees exactly which logins go.
      const preview = await fetch('/api/crm/admin-actions/cleanup-portal-logins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contact.id, dry_run: true }),
      })
      const pdata = await preview.json()
      if (!preview.ok) { toast.error(pdata.error ?? 'Preview failed'); return }
      const toDelete: { email: string | null }[] = pdata.would_delete ?? []
      if (toDelete.length === 0) { toast.success(pdata.message ?? 'No duplicate logins to clean.'); return }
      const ok = confirm(
        `Delete ${toDelete.length} duplicate portal login(s)?\n\n` +
        `Keep:   ${pdata.keep?.email ?? '(none)'}\n` +
        `Delete: ${toDelete.map(d => d.email).join(', ')}\n\n` +
        'This permanently removes the stray login(s). The kept login is untouched.',
      )
      if (!ok) return
      const res = await fetch('/api/crm/admin-actions/cleanup-portal-logins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contact.id, dry_run: false }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(data.message)
        setTimeout(() => window.location.reload(), 1200)
      } else {
        toast.error(data.error ?? 'Cleanup failed')
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
              {!portalExists ? (
                <span className="text-sm text-zinc-400">Not created</span>
              ) : suspended ? (
                <>
                  <Ban className="h-4 w-4 text-red-500" />
                  <span className="text-sm font-medium text-red-700">Suspended</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  <span className="text-sm font-medium text-emerald-700">Active</span>
                </>
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
                    <option value="formation">formation</option>
                    <option value="onboarding">onboarding</option>
                    <option value="active">active</option>
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
                  if (!confirm('Send the client a NEW temporary password? Their current password will stop working.')) return
                  handleAction('reset_password')
                }}
                disabled={loading === 'reset_password'}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-700 text-sm font-medium hover:bg-amber-100 disabled:opacity-50 transition-colors"
              >
                {loading === 'reset_password' ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                Send new password
              </button>
              <p className="mt-1 max-w-md text-xs leading-snug text-zinc-500">
                {(contact as { portal_email_sent_at?: string | null }).portal_email_sent_at
                  ? `Welcome email with login details was originally sent on ${new Date((contact as { portal_email_sent_at?: string | null }).portal_email_sent_at as string).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}. `
                  : 'No original credentials email is on record. '}
                This sends a <strong>new temporary password</strong> only (not the full welcome email) — the old password stops working and the client sets their own at next login.
              </p>

              {/* Suspend / Unsuspend portal login. Blocks the person's login
                  entirely (auth ban) without touching tier or company status.
                  One login per person, so suspend affects every company they
                  can reach — the confirm dialog lists them. */}
              {suspended ? (
                <button
                  onClick={() => handleSuspendToggle('unsuspend')}
                  disabled={loading === 'unsuspend'}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm font-medium hover:bg-emerald-100 disabled:opacity-50 transition-colors"
                >
                  {loading === 'unsuspend' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  Unsuspend Login
                </button>
              ) : (
                <button
                  onClick={() => handleSuspendToggle('suspend')}
                  disabled={loading === 'suspend'}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm font-medium hover:bg-red-100 disabled:opacity-50 transition-colors"
                >
                  {loading === 'suspend' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
                  Suspend Login
                </button>
              )}
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

          {/* Clean up duplicate portal logins — keeps the login matching the
              contact's primary email, removes strays (orphans). Previews before
              deleting; no-op when there's only the canonical login. */}
          <button
            onClick={handleCleanupLogins}
            disabled={loading === 'cleanup_logins'}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-700 text-sm font-medium hover:bg-amber-100 disabled:opacity-50 transition-colors mt-3"
            title="Remove duplicate/orphan portal logins for this contact, keeping the one matching the primary email"
          >
            {loading === 'cleanup_logins' ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Clean Up Duplicate Logins
          </button>
        </div>

      {/* Member Access — per-account revoke/restore for contacts with Member role */}
      {memberAccounts.length > 0 && (
        <div className="bg-white rounded-lg border p-5 space-y-4">
          <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Member Access</h3>
          <div className="space-y-3">
            {memberAccounts.map(acct => {
              const isRevoked = revokedAccountIds.has(acct.id)
              const actionKey = `${isRevoked ? 'restore' : 'revoke'}_access_${acct.id}`
              return (
                <div key={acct.id} className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{acct.company_name}</p>
                    {isRevoked && <p className="text-xs text-red-500">Access revoked</p>}
                  </div>
                  {isRevoked ? (
                    <button
                      onClick={() => {
                        if (!confirm(`Restore access for ${contact.full_name} to ${acct.company_name}?`)) return
                        handleAction('restore_access', { account_id: acct.id })
                      }}
                      disabled={loading === actionKey}
                      className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 text-xs font-medium hover:bg-emerald-100 disabled:opacity-50 transition-colors"
                    >
                      {loading === actionKey ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      Restore Access
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        if (!confirm(`Revoke ${contact.full_name}&apos;s portal access to ${acct.company_name}?`)) return
                        handleAction('revoke_access', { account_id: acct.id })
                      }}
                      disabled={loading === actionKey}
                      className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs font-medium hover:bg-red-100 disabled:opacity-50 transition-colors"
                    >
                      {loading === actionKey ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      Revoke Access
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
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
  const [docMap, setDocMap] = useState<Record<string, { docId: string; portalVisible: boolean }>>({})
  const [ocrViewDocId, setOcrViewDocId] = useState<string | null>(null)

  const ocrBtn = (fileId: string) => docMap[fileId]?.docId ? (
    <button
      onClick={() => setOcrViewDocId(docMap[fileId].docId)}
      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-blue-50 text-zinc-400 hover:text-blue-600 transition-all"
      title="View OCR text"
    >
      <ScanText className="h-3.5 w-3.5" />
    </button>
  ) : null

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
        setDocMap(json.docMap || {})
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
      <OcrViewerModal documentId={ocrViewDocId} onClose={() => setOcrViewDocId(null)} />
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
                  {ocrBtn(file.id)}
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
                      {ocrBtn(file.id)}
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
              {ocrBtn(file.id)}
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
  const [deleteDialog, setDeleteDialog] = useState<{ docId: string; fileName: string; documentType?: string | null } | null>(null)
  const [ocrRunning, setOcrRunning] = useState<string | null>(null)
  const [ocrViewDocId, setOcrViewDocId] = useState<string | null>(null)
  const [togglingVis, setTogglingVis] = useState<string | null>(null)
  const [activeDocScope, setActiveDocScope] = useState<string>('personal')
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

  const handleToggleVisibility = async (docId: string, current: boolean) => {
    setTogglingVis(docId)
    try {
      const result = await toggleDocumentPortalVisibility(docId, !current)
      if (result.success) {
        toast.success(`Portal visibility ${!current ? 'enabled' : 'disabled'}`)
        window.location.reload()
      } else {
        toast.error(result.error || 'Failed to update visibility')
        setTogglingVis(null)
      }
    } catch {
      toast.error('Network error')
      setTogglingVis(null)
    }
  }

  const handleDeleteDoc = (docId: string, fileName: string, documentType?: string | null) => {
    setDeleteDialog({ docId, fileName, documentType })
  }

  const handleConfirmDeleteDoc = async (): Promise<{ success: boolean; error?: string; message?: string }> => {
    if (!deleteDialog) return { success: false, error: 'No document selected' }
    setDeleting(deleteDialog.docId)
    try {
      const res = await fetch('/api/crm/admin-actions/delete-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: deleteDialog.docId }),
      })
      const data = await res.json()
      if (data.success) {
        // Reload after the toast shows via onSuccess so the dialog can close cleanly.
        setTimeout(() => window.location.reload(), 250)
        return { success: true, message: data.detail }
      }
      return { success: false, error: data.detail || 'Delete failed' }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Network error' }
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

  // Document scopes: "Personal" (no company attached) + one per company the
  // contact belongs to. A doc carrying an account_id belongs to that company's
  // scope; a doc with no account_id is personal. Lets staff see each company's
  // files on its own tab instead of one merged pile (Adam Mihaly owns THW + LUMA).
  const docScopes = [
    { key: 'personal', label: 'Personal', count: documents.filter(d => !d.account_id).length },
    ...accounts.map(a => ({
      key: a.id,
      label: a.company_name,
      count: documents.filter(d => d.account_id === a.id).length,
    })),
  ]
  const scopedDocuments = activeDocScope === 'personal'
    ? documents.filter(d => !d.account_id)
    : documents.filter(d => d.account_id === activeDocScope)

  const grouped = scopedDocuments.reduce<Record<string, ContactDocumentRecord[]>>((acc, doc) => {
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
        <p className="text-sm text-muted-foreground">{scopedDocuments.length} documents</p>
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

      {/* Scope tabs: Personal (contact's own files) + one per company the contact belongs to */}
      <div className="flex flex-wrap gap-2 border-b pb-2">
        {docScopes.map(scope => (
          <button
            key={scope.key}
            onClick={() => setActiveDocScope(scope.key)}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
              activeDocScope === scope.key
                ? 'bg-blue-600 text-white'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
            )}
          >
            {scope.label || 'Company'}
            <span className={cn(
              'text-[10px] px-1.5 py-0.5 rounded-full',
              activeDocScope === scope.key ? 'bg-white/20 text-white' : 'bg-white text-zinc-500'
            )}>
              {scope.count}
            </span>
          </button>
        ))}
      </div>

      {scopedDocuments.length === 0 && (
        <div className="bg-white rounded-lg border p-8 text-center text-sm text-muted-foreground">
          <FolderOpen className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>No documents in this section</p>
        </div>
      )}

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
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); handleToggleVisibility(doc.id, !!doc.portal_visible) }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); handleToggleVisibility(doc.id, !!doc.portal_visible) } }}
                      className={cn(
                        'p-1 rounded transition-colors',
                        doc.portal_visible ? 'text-emerald-600 hover:bg-emerald-50' : 'text-zinc-400 hover:bg-zinc-100',
                        togglingVis === doc.id && 'opacity-50 pointer-events-none'
                      )}
                      title={doc.portal_visible ? 'Visible to client — click to hide' : 'Hidden from client — click to show'}
                    >
                      {togglingVis === doc.id ? <Loader2 className="h-4 w-4 animate-spin" /> : doc.portal_visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                    </span>
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
                  {doc.drive_file_id && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); setOcrViewDocId(doc.id) }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setOcrViewDocId(doc.id) } }}
                      className="p-1 rounded hover:bg-blue-50 text-zinc-400 hover:text-blue-600 transition-colors"
                      title="View OCR text"
                    >
                      <ScanText className="h-3.5 w-3.5" />
                    </span>
                  )}
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); handleDeleteDoc(doc.id, doc.file_name, doc.document_type_name) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); handleDeleteDoc(doc.id, doc.file_name, doc.document_type_name) } }}
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

      {/* Delete confirmation */}
      <ConfirmDestructiveDialog
        open={!!deleteDialog}
        onClose={() => setDeleteDialog(null)}
        title="Delete Document"
        description={deleteDialog ? `Delete "${deleteDialog.fileName}"? The file will be moved to Drive trash (recoverable 30 days). The database record will be permanently removed.` : undefined}
        severity="red"
        staticPreview={deleteDialog ? {
          affected: { document: 1 },
          items: [
            {
              label: deleteDialog.fileName,
              details: deleteDialog.documentType ? [deleteDialog.documentType] : [],
            },
          ],
          warnings: ['Drive file moved to trash (30-day recovery). Document record permanently deleted.'],
        } : undefined}
        confirmLabel="Delete Document"
        onConfirm={handleConfirmDeleteDoc}
      />

      {/* Preview modal */}
      <OcrViewerModal documentId={ocrViewDocId} onClose={() => setOcrViewDocId(null)} />
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

function InvoicesTab({ invoices, accounts }: { invoices: ContactInvoice[]; accounts: LinkedAccount[] }) {
  const [dialogOpen, setDialogOpen] = useState(false)

  // Primary linked account for pre-filling invoice dialog
  const primaryAccount = accounts[0] ?? null

  const dialogDefaults: InvoiceDialogDefaults | undefined = primaryAccount
    ? { accountId: primaryAccount.id, accountName: primaryAccount.company_name }
    : undefined

  const handleSendInvoice = async (paymentId: string) => {
    try {
      const res = await fetch(`/api/invoices/${paymentId}/send`, { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        return { success: false, error: (d as { error?: string }).error ?? 'Failed to send invoice' }
      }
      return { success: true }
    } catch {
      return { success: false, error: 'Failed to send invoice' }
    }
  }

  const real = invoices.filter(i => i.invoice_number && i.invoice_number !== '1.0' && i.invoice_number !== '2.0')
  const legacy = invoices.filter(i => !i.invoice_number || i.invoice_number === '1.0' || i.invoice_number === '2.0')

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
    <>
      {/* Header with "Invoice this contact" button */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Invoices</h3>
        <button
          onClick={() => setDialogOpen(true)}
          disabled={!primaryAccount}
          title={primaryAccount ? `Invoice ${primaryAccount.company_name}` : 'No linked account'}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus className="h-3.5 w-3.5" />
          Invoice
        </button>
      </div>

      <InvoiceDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        mode="invoice"
        defaultValues={dialogDefaults}
        onCreateInvoice={createInvoice}
        onSendInvoice={handleSendInvoice}
      />

      {real.length === 0 && legacy.length === 0 ? (
        <p className="text-sm text-muted-foreground">No invoices found</p>
      ) : (
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
      )}
    </>
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
