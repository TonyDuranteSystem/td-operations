'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { WorkflowIssuesLink } from '@/components/accounts/workflow-issues-link'
import {
  ArrowLeft, Building2, User, Users, Mail, Phone, Globe, MapPin,
  Calendar, Shield, FileText, CreditCard, Briefcase, Clock,
  AlertCircle, CheckCircle2, ExternalLink, MessageSquare, Inbox, Unlink,
  Pencil, Plus, Search, Loader2, Stethoscope, X, Activity, BadgeCheck, Send,
  Rocket, Upload, Hash, DollarSign, ListOrdered, Bell,
} from 'lucide-react'
import { ACCOUNT_TYPE } from '@/lib/constants'
import { AccountCommunications } from './account-communications'
import { EditableField } from './editable-field'
import { EntityActivitySummary } from '@/components/dashboard/entity-activity-summary'
import { ReferralsGivenCard } from '@/components/referrals/referrals-given-card'
import { PortalUserButton } from './portal-user-button'
import { PortalTransitionButton } from './portal-transition-button'
import { ComposeEmailButton } from '@/components/inbox/compose-email-button'
import { DocumentsPanel } from '@/app/(dashboard)/accounts/[id]/components/documents-panel'
import { GenerateOADialog } from '@/app/(dashboard)/accounts/[id]/components/generate-oa-dialog'
import { GenerateLeaseDialog } from '@/app/(dashboard)/accounts/[id]/components/generate-lease-dialog'
import { RegenLeasePdfDialog } from '@/app/(dashboard)/accounts/[id]/components/regen-lease-pdf-dialog'
import { GenerateSS4Dialog } from '@/app/(dashboard)/accounts/[id]/components/generate-ss4-dialog'
import { GenerateIntercompanyDialog } from '@/app/(dashboard)/accounts/[id]/components/generate-intercompany-dialog'
import { normalizeEntityType } from '@/lib/portal/entity-type'
import { SS4PipelineCard } from '@/components/contacts/ss4-pipeline-card'
import { type ServiceDeliveryForStepper } from './service-deliveries-section'
import { SdPipelineStepper, type PipelineStage } from './sd-pipeline-stepper'
import { FlowChips } from '@/components/flows/flow-chips'
import { ThreadEmailPanel } from '@/components/portal-chats/thread-email-panel'
import { AccountEmailsCard } from './account-emails-card'
import type { ResolvedFlow } from '@/lib/flows/resolve-flows'
import { DeactivateServiceButton, ReactivateServiceButton } from './service-status-actions'
import { PlaceClientWizard } from '@/app/(dashboard)/accounts/[id]/components/place-client-wizard'
import { ClientDiagnosticDialog } from '@/app/(dashboard)/accounts/[id]/components/client-diagnostic-dialog'
import { FileManager } from './file-manager'
import { AccountDocumentsList } from './account-documents-list'
import { CorrespondenceUpload } from './correspondence-upload'
import { AccountOfferPanel, type OfferData } from '@/components/offers/account-offer-panel'
import { AccountJourney } from './account-journey'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { updateAccountField, updateContactField, addAccountNote, updateAccountContactRole, promoteAccountToActive, createDBA, updateDBADetails } from '@/app/(dashboard)/accounts/actions'
import { StatusChangeDialog } from './status-change-dialog'
import { ConfirmDestructiveDialog } from '@/components/ui/confirm-destructive-dialog'
import { BackendActivityPanel } from '@/components/shared/backend-activity-panel'
import { ClientConversationsPanel } from '@/components/conversations/client-conversations-panel'
import { ActivityFeed } from './activity-feed'
import { AddressPicker } from '@/components/shared/address-picker'
import { RAPicker } from '@/components/shared/ra-picker'
import { PaymentRowActions } from '@/components/accounts/payment-row-actions'
import { InvoiceNoteDot } from '@/components/payments/invoice-note-dot'
import { TaxRowActions } from '@/components/tax-returns/tax-row-actions'
import { InvoiceDialog, type InvoiceDialogDefaults } from '@/components/payments/invoice-dialog'
import { createInvoice } from '@/app/(dashboard)/payments/invoice-actions'
import { differenceInDays, parseISO, format } from 'date-fns'
import type { Account, Contact, Service, Payment, Deal, TaxReturn } from '@/lib/types'
import { resolveExtensionDeadline, type TaxReturnType } from '@/lib/tax/extension-deadline'

const TABS = [
  { key: 'overview', label: 'Overview', icon: Building2, adminOnly: false },
  { key: 'services', label: 'Services', icon: Briefcase, adminOnly: false },
  { key: 'payments', label: 'Payments', icon: CreditCard, adminOnly: true },
  { key: 'tax', label: 'Tax Returns', icon: FileText, adminOnly: false },
  { key: 'documents', label: 'Documents', icon: FileText, adminOnly: false },
  { key: 'emails', label: 'Emails', icon: Inbox, adminOnly: false },
  { key: 'correspondence', label: 'Correspondence', icon: Inbox, adminOnly: false },
  { key: 'communications', label: 'Communications', icon: MessageSquare, adminOnly: false },
  { key: 'conversations', label: 'Conversations', icon: MessageSquare, adminOnly: false },
  { key: 'activity', label: 'Activity', icon: ListOrdered, adminOnly: false },
  { key: 'backend', label: 'Backend', icon: Activity, adminOnly: true },
]

const SERVICE_STATUS_COLORS: Record<string, string> = {
  'Not Started': 'bg-zinc-100 text-zinc-700',
  'In Progress': 'bg-blue-100 text-blue-700',
  Blocked: 'bg-red-100 text-red-700',
  Completed: 'bg-emerald-100 text-emerald-700',
  Cancelled: 'bg-zinc-100 text-zinc-500',
}

const PAYMENT_STATUS_COLORS: Record<string, string> = {
  Paid: 'bg-emerald-100 text-emerald-700',
  Due: 'bg-amber-100 text-amber-700',
  Overdue: 'bg-red-100 text-red-700',
  'Partially Paid': 'bg-orange-100 text-orange-700',
  Cancelled: 'bg-zinc-100 text-zinc-500',
  Waived: 'bg-zinc-100 text-zinc-500',
}

const TIER_COLORS: Record<string, string> = {
  lead: 'bg-zinc-100 text-zinc-600',
  formation: 'bg-purple-100 text-purple-700',
  onboarding: 'bg-amber-100 text-amber-700',
  active: 'bg-emerald-100 text-emerald-700',
  full: 'bg-blue-100 text-blue-700',
}

const ENTITY_LABELS: Record<string, string> = {
  'Single Member LLC': 'SMLLC',
  'Multi Member LLC': 'MMLLC',
  'C-Corp Elected': 'C-Corp',
}

function formatDate(d: string | null): string {
  if (!d) return '—'
  try {
    return format(parseISO(d), 'MMM d, yyyy')
  } catch {
    return d
  }
}

function formatCurrency(amount: number | null, currency?: string | null): string {
  if (amount == null) return '—'
  // ⛔ FALLBACK, NOT SILENT $ (2026-08-14, council pass, senior-engineer) — the plan-currency
  // validator accepts any non-empty currency string, no EUR/USD restriction, so a symbol-only
  // map silently mislabels anything else as $ on exactly the screens meant to let a human catch
  // a wrong number before money moves. TD only actually uses EUR/USD today, so this fallback is
  // not expected to render in practice — it exists so an unexpected value is visibly honest
  // (e.g. "GBP 500.00") instead of confidently wrong.
  const c = currency === 'EUR' ? '€' : currency === 'USD' || !currency ? '$' : `${currency} `
  return `${c}${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

interface DocumentRecord {
  id: string
  file_name: string
  document_type_name: string | null
  category_name: string | null
  category: number | null
  confidence: string | null
  drive_file_id: string | null
  drive_link: string | null
  status: string | null
  processed_at: string | null
  mime_type: string | null
  file_size: number | null
  portal_visible: boolean
}

// OfferData is imported from account-offer-panel.tsx (the panel that actually
// renders it) rather than duplicated here — a second, independent copy of
// this shape is exactly what let packages/selected_package_key/
// package_locked_at go unnoticed on this file the first time (found by
// adversarial review). One definition now; this file never needs touching
// again when the panel's data needs change.

interface AccountDetailProps {
  account: Account
  /** Client-facing base URL for the current environment (server-computed). */
  appBaseUrl?: string
  contacts: Contact[]
  services: Service[]
  payments: Payment[]
  deals: Deal[]
  taxReturns: TaxReturn[]
  documents?: DocumentRecord[]
  today: string
  isAdmin?: boolean
  offer?: OfferData | null
  partnerName?: string | null
  pendingActivation?: {
    signed_at: string | null
    payment_confirmed_at: string | null
    payment_method: string | null
    activated_at: string | null
    status: string | null
  } | null
  wizardProgress?: {
    status: string
    current_step: number
    wizard_type: string
    updated_at: string
  } | null
  serviceDeliveriesRaw?: Array<{
    status: string | null
    stage: string | null
    pipeline: string | null
    service_name: string | null
  }>
  allWizards?: Array<{
    wizard_type: string
    status: string
    current_step: number
    updated_at: string
    data: Record<string, unknown> | null
  }>
  bankReferrals?: Array<{
    slug: string
    label: string
    clicked_at: string | null
  }>
  ss4Applications?: Array<{
    id: string
    token: string
    account_id: string
    company_name: string
    status: string
    signed_at: string | null
    pdf_signed_drive_id: string | null
  }>
  ss4ServiceDeliveries?: Array<{
    id: string
    service_type: string
    stage: string | null
    status: string
    account_id: string | null
  }>
  stepperDeliveries?: ServiceDeliveryForStepper[]
  stagesByServiceType?: Record<string, PipelineStage[]>
  // DBA service deliveries for this account. Joined with dba_details so the
  // registration-specific fields (dba_name, jurisdiction) render alongside
  // the pipeline stage. stage_order + updated_at carry the optimistic-lock
  // payload that the SdPipelineStepper needs to advance the stage.
  dbaServiceDeliveries?: Array<{
    id: string
    service_name: string | null
    stage: string | null
    stage_order: number | null
    status: string | null
    start_date: string | null
    end_date: string | null
    notes: string | null
    updated_at: string
    // dba_details row fields. detail_id / detail_updated_at are nullable
    // because a DBA SD can exist before its details row is inserted (legacy
    // data path); the UI shows "—" and disables editing in that case.
    detail_id: string | null
    detail_updated_at: string | null
    dba_name: string | null
    jurisdiction: string | null
    filed_date: string | null
    registration_number: string | null
    renewal_date: string | null
    renewal_period: string | null
    filing_fee: number | null
    detail_notes: string | null
  }>
  // Service Flow Workspaces — recurring flows for this account (live SDs +
  // date-derived scheduled placeholders). Rendered as chips in the Services tab.
  flows?: ResolvedFlow[]
}

// ─── Contacts Section with Link/Unlink ────────────────────
function ContactsSection({
  contacts,
  account,
  makeContactSaver,
}: {
  contacts: Contact[]
  account: Account
  makeContactSaver: (contactId: string, field: string, updatedAt: string) => (value: string) => Promise<{ success: boolean; error?: string }>
}) {
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ id: string; full_name: string; email: string | null }[]>([])
  const [searching, setSearching] = useState(false)
  const [linking, setLinking] = useState(false)
  const [selectedRole, setSelectedRole] = useState('owner')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [creating, setCreating] = useState(false)
  const [unlinkTarget, setUnlinkTarget] = useState<{ id: string; name: string; role: string | null } | null>(null)
  const [sendingNewContact, setSendingNewContact] = useState(false)
  const [updatingContactId, setUpdatingContactId] = useState<string | null>(null)

  const CONTACT_ROLE_OPTIONS = [
    { label: '—', value: '' },
    { label: 'Owner / Sole Member', value: 'owner' },
    { label: 'Authorized Representative', value: 'authorized_representative' },
    { label: 'Manager', value: 'manager' },
    { label: 'Accountant', value: 'accountant' },
  ]

  const makeRoleSaver = (contactId: string) => async (value: string) => {
    const result = await updateAccountContactRole(account.id, contactId, value)
    if (result.success) toast.success('Role updated')
    else toast.error(result.error ?? 'Failed')
    return result
  }

  const handleUnlinkConfirm = async () => {
    if (!unlinkTarget) return { success: false, error: 'No contact selected' }
    const { unlinkContactFromAccount } = await import('@/app/(dashboard)/accounts/actions')
    const result = await unlinkContactFromAccount(account.id, unlinkTarget.id)
    if (result.success) {
      setTimeout(() => window.location.reload(), 250)
      return { success: true, message: `${unlinkTarget.name} unlinked` }
    }
    return { success: false, error: result.error ?? 'Failed to unlink contact' }
  }

  const handleSearch = async (query: string) => {
    setSearchQuery(query)
    if (query.length < 2) { setSearchResults([]); return }
    setSearching(true)
    try {
      const { searchContacts } = await import('@/app/(dashboard)/accounts/actions')
      const results = await searchContacts(query)
      // Filter out contacts already linked
      const linkedIds = new Set(contacts.map(c => c.id))
      setSearchResults(results.filter(r => !linkedIds.has(r.id)))
    } catch {
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }

  const handleCreateAndLink = async () => {
    if (!searchQuery.trim()) return
    setCreating(true)
    try {
      const { createAndLinkContact } = await import('@/app/(dashboard)/accounts/actions')
      const result = await createAndLinkContact(account.id, searchQuery.trim(), newEmail.trim() || null, selectedRole)
      if (result.success) {
        if (result.warning) {
          // Longer duration + a real delay before reload — an immediate
          // reload wiped this toast before it could ever render (BLOCKER,
          // council review 2026-08-19, dev_task 693273fd). Duration matches
          // the ss4Note warning pattern already used elsewhere in this file.
          toast.warning(result.warning, { duration: 12000 })
        } else {
          toast.success(`${searchQuery.trim()} created and linked as ${selectedRole}`)
        }
        setShowSearch(false)
        setShowCreateForm(false)
        setSearchQuery('')
        setNewEmail('')
        setSearchResults([])
        // Delay matches the toast's own duration above — a page reload kills
        // the toast outright regardless of its configured duration, so the
        // two numbers must agree or the stated 12s window is a lie (Bug
        // Hunter + Senior Engineer review, 2026-08-19, dev_task 693273fd).
        setTimeout(() => window.location.reload(), result.warning ? 12000 : 250)
      } else {
        toast.error(result.error ?? 'Failed to create contact')
      }
    } catch {
      toast.error('Failed to create contact')
    } finally {
      setCreating(false)
    }
  }

  const handleSendNewContactRequest = async () => {
    setSendingNewContact(true)
    try {
      const res = await fetch(`/api/accounts/${account.id}/contact-request`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Failed to send request')
        return
      }
      toast.success(data.is_existing ? 'Request resent via portal chat' : 'Request sent via portal chat')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send request')
    } finally {
      setSendingNewContact(false)
    }
  }

  const handleSendUpdateRequest = async (contactId: string, contactName: string) => {
    setUpdatingContactId(contactId)
    try {
      const res = await fetch(`/api/contacts/${contactId}/update-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: account.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Failed to send update request')
        return
      }
      toast.success(`Update request sent to ${contactName}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send update request')
    } finally {
      setUpdatingContactId(null)
    }
  }

  const handleLink = async (contactId: string, contactName: string) => {
    setLinking(true)
    try {
      const { linkContactToAccount } = await import('@/app/(dashboard)/accounts/actions')
      const result = await linkContactToAccount(account.id, contactId, selectedRole)
      if (result.success) {
        toast.success(`${contactName} linked as ${selectedRole}`)
        setShowSearch(false)
        setSearchQuery('')
        setSearchResults([])
        window.location.reload()
      } else {
        toast.error(result.error ?? 'Failed to link contact')
      }
    } catch {
      toast.error('Failed to link contact')
    } finally {
      setLinking(false)
    }
  }

  return (
    <div className="bg-white rounded-lg border p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
          Contacts ({contacts.length})
        </h3>
        <div className="flex items-center gap-3">
          <button
            onClick={handleSendNewContactRequest}
            disabled={sendingNewContact || contacts.length === 0}
            className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 hover:text-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed"
            title={contacts.length === 0 ? 'Link a contact first to receive the request' : 'Send a form to the owner to add a new contact'}
          >
            {sendingNewContact ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Request New Contact
          </button>
          <button
            onClick={() => setShowSearch(!showSearch)}
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            <Plus className="h-3.5 w-3.5" />
            Link Contact
          </button>
        </div>
      </div>

      {/* Link contact search */}
      {showSearch && (
        <div className="space-y-2 p-3 bg-zinc-50 rounded-lg border">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-zinc-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => handleSearch(e.target.value)}
                placeholder="Search by name..."
                className="w-full pl-8 pr-3 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
            </div>
            <select
              value={selectedRole}
              onChange={e => setSelectedRole(e.target.value)}
              className="text-xs border rounded-md px-2 py-1.5 bg-white"
            >
              <option value="owner">Owner</option>
              <option value="member">Member</option>
              <option value="manager">Manager</option>
              <option value="authorized">Authorized</option>
            </select>
            <button
              onClick={() => { setShowSearch(false); setSearchQuery(''); setSearchResults([]) }}
              className="text-xs text-zinc-500 hover:text-zinc-700"
            >
              Cancel
            </button>
          </div>
          {searching && (
            <div className="flex items-center gap-2 text-xs text-zinc-400 py-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Searching...
            </div>
          )}
          {searchResults.length > 0 && (
            <div className="divide-y border rounded-md bg-white max-h-40 overflow-y-auto">
              {searchResults.map(r => (
                <button
                  key={r.id}
                  onClick={() => handleLink(r.id, r.full_name)}
                  disabled={linking}
                  className="flex items-center justify-between w-full px-3 py-2 text-sm hover:bg-blue-50 transition-colors disabled:opacity-50"
                >
                  <div>
                    <span className="font-medium">{r.full_name}</span>
                    {r.email && <span className="text-xs text-zinc-400 ml-2">{r.email}</span>}
                  </div>
                  <Plus className="h-3.5 w-3.5 text-blue-600" />
                </button>
              ))}
            </div>
          )}
          {searchQuery.length >= 2 && !searching && searchResults.length === 0 && (
            <div className="space-y-2">
              <p className="text-xs text-zinc-400 py-1">No contacts found</p>
              {!showCreateForm ? (
                <button
                  onClick={() => setShowCreateForm(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Create &quot;{searchQuery.trim()}&quot; as new contact
                </button>
              ) : (
                <div className="p-3 bg-white border rounded-lg space-y-2">
                  <p className="text-xs font-medium">Create new contact: <span className="text-blue-600">{searchQuery.trim()}</span></p>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={e => setNewEmail(e.target.value)}
                    placeholder="Email (optional)"
                    className="w-full px-3 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleCreateAndLink}
                      disabled={creating}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                    >
                      {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                      Create & Link
                    </button>
                    <button
                      onClick={() => setShowCreateForm(false)}
                      className="px-3 py-1.5 text-xs border rounded-md hover:bg-zinc-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {contacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No linked contacts</p>
      ) : (
        <div className="space-y-4">
          {contacts.map(c => (
            <div key={c.id} className="space-y-2 pb-3 border-b last:border-b-0">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-zinc-100 flex items-center justify-center shrink-0">
                  <User className="h-3.5 w-3.5 text-zinc-500" />
                </div>
                <Link href={`/contacts/${c.id}`} className="font-medium text-sm text-blue-600 hover:underline">
                  {c.full_name}
                </Link>
                <button
                  onClick={() => handleSendUpdateRequest(c.id, c.full_name)}
                  disabled={updatingContactId === c.id}
                  className="ml-auto p-1 rounded hover:bg-emerald-50 text-zinc-300 hover:text-emerald-600 transition-colors disabled:opacity-40"
                  title={`Ask ${c.full_name} to confirm or update their info`}
                >
                  {updatingContactId === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                </button>
                <button
                  onClick={() => setUnlinkTarget({ id: c.id, name: c.full_name, role: c.role ?? null })}
                  className="p-1 rounded hover:bg-red-50 text-zinc-300 hover:text-red-500 transition-colors"
                  title={`Remove ${c.full_name} from this company`}
                >
                  <Unlink className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="pl-9 grid gap-1.5">
                <EditableField icon={Users} label="Role" type="select" options={CONTACT_ROLE_OPTIONS} value={c.role ?? ''} onSave={makeRoleSaver(c.id)} />
                <EditableField icon={Mail} label="Email" value={c.email ?? ''} onSave={makeContactSaver(c.id, 'email', c.updated_at)} />
                <EditableField icon={Phone} label="Phone" value={c.phone ?? ''} onSave={makeContactSaver(c.id, 'phone', c.updated_at)} />
                <EditableField icon={Globe} label="Language" type="select" options={[{ label: '', value: '' }, { label: 'English', value: 'English' }, { label: 'Italian', value: 'Italian' }]} value={c.language ?? ''} onSave={makeContactSaver(c.id, 'language', c.updated_at)} />
              </div>
            </div>
          ))}
        </div>
      )}
      <ConfirmDestructiveDialog
        open={!!unlinkTarget}
        onClose={() => setUnlinkTarget(null)}
        title="Unlink Contact"
        description={unlinkTarget ? `Remove ${unlinkTarget.name} from ${account.company_name}?` : undefined}
        severity="amber"
        staticPreview={unlinkTarget ? {
          affected: { link: 1 },
          items: [
            {
              label: unlinkTarget.name,
              details: unlinkTarget.role ? [unlinkTarget.role] : [],
            },
          ],
          warnings: [
            'The contact record itself is not deleted — only the link to this company is removed.',
            'Documents and services associated with this company are not affected.',
          ],
        } : undefined}
        confirmLabel="Unlink"
        onConfirm={handleUnlinkConfirm}
      />
    </div>
  )
}

export function AccountDetail({ account, appBaseUrl = 'https://app.tonydurante.us', contacts, services, payments, deals, taxReturns, documents = [], today, isAdmin = false, offer = null, partnerName = null, pendingActivation = null, wizardProgress = null, serviceDeliveriesRaw = [], allWizards = [], bankReferrals = [], ss4Applications = [], ss4ServiceDeliveries = [], stepperDeliveries = [], stagesByServiceType = {}, dbaServiceDeliveries = [], flows = [] }: AccountDetailProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  // Deep-link support: a `?tab=<key>` param (e.g. from the What's New "Open"
  // button) selects that tab on load. Falls back to overview for missing/unknown
  // keys so a bad param never blanks the page.
  const tabParam = searchParams.get('tab')
  const initialTab = tabParam && TABS.some(t => t.key === tabParam) ? tabParam : 'overview'
  const [activeTab, setActiveTab] = useState(initialTab)
  const [showOADialog, setShowOADialog] = useState(false)
  const [showLeaseDialog, setShowLeaseDialog] = useState(false)
  const [showSS4Dialog, setShowSS4Dialog] = useState(false)
  const [showIntercompanyDialog, setShowIntercompanyDialog] = useState(false)
  const [regenLeaseData, setRegenLeaseData] = useState<{
    leaseId: string
    signedAt?: string | null
    termStartDate?: string | null
    termEndDate?: string | null
  } | null>(null)
  const [showPlaceClient, setShowPlaceClient] = useState(false)
  const [showDiagnostic, setShowDiagnostic] = useState(false)
  const [showStatusDialog, setShowStatusDialog] = useState(false)
  const [showEINReceived, setShowEINReceived] = useState(false)
  const [promoting, setPromoting] = useState(false)

  const primaryContact = contacts[0] || null

  // Cast once: account.portal_tier is not in the generated Account type yet.
  const accountPortalTier = (account as unknown as Record<string, unknown>).portal_tier as string | null

  const handlePromoteToActive = async () => {
    if (!confirm(`Promote ${account.company_name} from onboarding → active?\n\nThis grants full portal access. Use after the onboarding form has been reviewed and the CRM setup is complete.`)) {
      return
    }
    setPromoting(true)
    const res = await promoteAccountToActive(account.id)
    setPromoting(false)
    if (res.success) {
      toast.success('Promoted to active')
      router.refresh()
    } else {
      toast.error(res.error ?? 'Failed to promote')
    }
  }

  const activeServices = services.filter(s => s.status !== 'Completed' && s.status !== 'Cancelled')
  const formationSD = services.find(s => s.service_type === 'Company Formation' && s.status !== 'Completed' && s.status !== 'Cancelled')
  const overduePayments = payments.filter(p =>
    (p.status === 'Due' || p.status === 'Overdue' || p.status === 'Partially Paid') &&
    p.due_date && p.due_date < today
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <button
          onClick={() => router.back()}
          className="mt-1 p-1.5 rounded-lg hover:bg-zinc-100 transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <EditableField label="" value={account.company_name} onSave={async (v) => { const r = await updateAccountField(account.id, 'company_name', v, account.updated_at); if (r.success) toast.success('Saved'); else toast.error(r.error ?? 'Failed'); return r }} className="text-2xl font-semibold tracking-tight" />
            {account.entity_type && (
              <span className="text-xs font-medium px-2 py-0.5 rounded bg-indigo-100 text-indigo-700">
                {ENTITY_LABELS[account.entity_type] ?? account.entity_type}
              </span>
            )}
            <span className={cn(
              'text-xs font-medium px-2 py-0.5 rounded',
              account.status === 'Active' ? 'bg-emerald-100 text-emerald-700' :
              account.status === 'Pending Formation' ? 'bg-blue-100 text-blue-700' :
              account.status === 'Closed' || account.status === 'Cancelled' ? 'bg-zinc-100 text-zinc-600' :
              account.status === 'Suspended' ? 'bg-amber-100 text-amber-700' :
              'bg-red-100 text-red-700'
            )}>
              {account.status}
            </span>
            {(account as unknown as Record<string, unknown>).portal_tier && (
              <span className={cn('text-xs font-medium px-2 py-0.5 rounded', TIER_COLORS[(account as unknown as Record<string, unknown>).portal_tier as string] ?? 'bg-zinc-100')}>
                {(account as unknown as Record<string, unknown>).portal_tier as string}
              </span>
            )}
            <PortalUserButton accountId={account.id} portalAccount={account.portal_account ?? false} />
            <PortalTransitionButton accountId={account.id} portalAccount={account.portal_account ?? false} />
            <ComposeEmailButton
              accountId={account.id}
              contactId={primaryContact?.id}
              to={
                (account as unknown as { communication_email?: string }).communication_email
                || primaryContact?.email
                || undefined
              }
              linkLabel={account.company_name}
            />
            <button
              onClick={() => setShowDiagnostic(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-amber-100 text-amber-700 hover:bg-amber-200 transition-colors"
            >
              <Stethoscope className="h-3.5 w-3.5" />
              Diagnose
            </button>
            <WorkflowIssuesLink accountId={account.id} />
            <button
              onClick={() => setShowPlaceClient(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-indigo-100 text-indigo-700 hover:bg-indigo-200 transition-colors"
            >
              <Building2 className="h-3.5 w-3.5" />
              Place Client
            </button>
            {isAdmin && formationSD && !account.ein_number && (
              <button
                onClick={() => setShowEINReceived(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-emerald-100 text-emerald-700 hover:bg-emerald-200 transition-colors"
              >
                <BadgeCheck className="h-3.5 w-3.5" />
                EIN Received
              </button>
            )}
            {isAdmin && accountPortalTier === 'onboarding' && account.ein_number && (
              <button
                onClick={handlePromoteToActive}
                disabled={promoting}
                className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-emerald-100 text-emerald-700 hover:bg-emerald-200 transition-colors disabled:opacity-50"
              >
                {promoting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
                {promoting ? 'Promoting…' : 'Promote to Active'}
              </button>
            )}
          </div>
          <p className="text-muted-foreground text-sm mt-1">
            {account.state_of_formation && `${account.state_of_formation} · `}
            {activeServices.length} active services · {overduePayments.length} overdue payments
          </p>
        </div>
      </div>

      {/* Alert banner for overdue */}
      {overduePayments.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="font-medium">{overduePayments.length} overdue payment{overduePayments.length === 1 ? '' : 's'}</span>
          <span className="text-red-600">
            — totale: {formatCurrency(overduePayments.reduce((sum, p) => sum + (p.amount_due ?? p.amount), 0))}
          </span>
        </div>
      )}

      {/* Account Journey Tracker — TOP priority, shows current lifecycle state */}
      <AccountJourney
        offer={offer ? { token: offer.token, status: offer.status, contract_type: offer.contract_type, created_at: offer.created_at, view_count: offer.view_count, viewed_at: offer.viewed_at, cost_summary: offer.cost_summary } : null}
        pendingActivation={pendingActivation}
        wizardProgress={wizardProgress}
        serviceDeliveries={serviceDeliveriesRaw}
        accountType={account.account_type ?? null}
        portalTier={(account as unknown as Record<string, unknown>).portal_tier as string ?? null}
        accountStatus={account.status ?? null}
        accountCreatedAt={account.created_at ?? null}
        hasSetupPayment={payments.some(p => p.status === 'Paid' && (p.description?.toLowerCase().includes('setup') || p.period === 'One-Time'))}
        hasPaidPayment={payments.some(p => p.status === 'Paid' && (p.amount_paid ?? 0) > 0)}
        allWizards={allWizards}
        bankReferrals={bankReferrals}
      />

      {/* Offer Panel */}
      <AccountOfferPanel
        accountId={account.id}
        companyName={account.company_name}
        clientEmail={primaryContact?.email || ''}
        clientLanguage={primaryContact?.language}
        contactId={primaryContact?.id}
        offer={offer}
        isAdmin={isAdmin}
        pendingActivation={pendingActivation}
      />

      {/* Documents to Sign Panel */}
      <DocumentsPanel
        accountId={account.id}
        isAdmin={true}
        appBaseUrl={appBaseUrl}
        onGenerateOA={() => setShowOADialog(true)}
        onGenerateLease={() => setShowLeaseDialog(true)}
        onGenerateSS4={() => setShowSS4Dialog(true)}
        onGenerateIntercompany={normalizeEntityType(account.entity_type) === 'MMLLC' ? () => setShowIntercompanyDialog(true) : undefined}
        onRegenLease={(leaseId, data) => setRegenLeaseData({ leaseId, ...data })}
      />

      {/* SS-4 / EIN Application Pipeline Card */}
      {ss4Applications.length > 0 && (
        <SS4PipelineCard
          ss4Applications={ss4Applications}
          serviceDeliveries={ss4ServiceDeliveries}
          accounts={[{ id: account.id, company_name: account.company_name, ein: account.ein_number ?? null }]}
          contactId={primaryContact?.id ?? ''}
        />
      )}

      {/* Generate Document Dialogs */}
      <GenerateOADialog
        open={showOADialog}
        onClose={() => setShowOADialog(false)}
        accountId={account.id}
        companyName={account.company_name}
        state={account.state_of_formation}
        entityType={account.entity_type}
        formationDate={account.formation_date}
        ein={account.ein_number}
      />
      <GenerateLeaseDialog
        open={showLeaseDialog}
        onClose={() => setShowLeaseDialog(false)}
        accountId={account.id}
        companyName={account.company_name}
        formationDate={account.formation_date}
      />
      <GenerateIntercompanyDialog
        open={showIntercompanyDialog}
        onClose={() => setShowIntercompanyDialog(false)}
        accountId={account.id}
        companyName={account.company_name}
      />
      <RegenLeasePdfDialog
        open={!!regenLeaseData}
        onClose={() => setRegenLeaseData(null)}
        leaseId={regenLeaseData?.leaseId ?? ''}
        signedAt={regenLeaseData?.signedAt}
        termStartDate={regenLeaseData?.termStartDate}
        termEndDate={regenLeaseData?.termEndDate}
      />
      <GenerateSS4Dialog
        open={showSS4Dialog}
        onClose={() => setShowSS4Dialog(false)}
        accountId={account.id}
        companyName={account.company_name}
        state={account.state_of_formation}
        entityType={account.entity_type}
        contactName={primaryContact?.full_name || ''}
        formationDate={account.formation_date}
        existingUnsignedStatus={(() => {
          const s = ss4Applications[0]
          return s && !s.signed_at && (s.status === 'draft' || s.status === 'awaiting_signature') ? s.status : null
        })()}
      />
      <PlaceClientWizard
        open={showPlaceClient}
        onClose={() => setShowPlaceClient(false)}
        accountId={account.id}
        companyName={account.company_name}
        state={account.state_of_formation}
        entityType={account.entity_type}
        contactName={primaryContact?.full_name || ''}
        ein={account.ein_number}
        formationDate={account.formation_date}
      />
      <ClientDiagnosticDialog
        open={showDiagnostic}
        onClose={() => setShowDiagnostic(false)}
        accountId={account.id}
        companyName={account.company_name}
      />
      <StatusChangeDialog
        open={showStatusDialog}
        onClose={() => setShowStatusDialog(false)}
        accountId={account.id}
        companyName={account.company_name}
        currentStatus={account.status ?? ''}
        updatedAt={account.updated_at}
      />
      <EINReceivedDialog
        open={showEINReceived}
        onClose={() => { setShowEINReceived(false); router.refresh() }}
        accountId={account.id}
        companyName={account.company_name}
      />

      {/* Tabs */}
      <div className="border-b">
        <div className="flex gap-1 -mb-px overflow-x-auto">
          {TABS.filter(tab => !tab.adminOnly || isAdmin).map(tab => {
            const Icon = tab.icon
            const count = tab.key === 'services' ? services.length :
                         tab.key === 'payments' ? payments.length :
                         tab.key === 'tax' ? taxReturns.length :
                         tab.key === 'documents' ? documents.length : null
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                  activeTab === tab.key
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-zinc-300'
                )}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
                {count !== null && count > 0 && (
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-600 ml-1">
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && (
        <>
          <PanoramicaTab account={account} contacts={contacts} deals={deals} payments={payments} isAdmin={isAdmin} partnerName={partnerName} onOpenStatusDialog={() => setShowStatusDialog(true)} dbaServiceDeliveries={dbaServiceDeliveries} stagesByServiceType={stagesByServiceType} />
          {/* Recent emails (auto-matched + linked) — visible without hunting
              for the Emails tab (Antonio 2026-07-08) */}
          <div className="px-4 pb-4">
            <AccountEmailsCard accountId={account.id} onOpenAll={() => setActiveTab('emails')} />
          </div>
        </>
      )}
      {activeTab === 'services' && (
        <ServiziTab services={services} today={today} accountId={account.id} accountType={account.account_type ?? null} stepperDeliveries={stepperDeliveries} stagesByServiceType={stagesByServiceType} payments={payments} flows={flows} />
      )}
      {activeTab === 'payments' && (
        <PagamentiTab payments={payments} today={today} account={account as unknown as { id: string; updated_at: string; dunning_reminder_1_days?: number | null; dunning_reminder_2_days?: number | null; dunning_pause?: boolean | null; dunning_pause_until?: string | null; dunning_pause_reason?: string | null }} />
      )}
      {activeTab === 'tax' && (
        <TaxTab taxReturns={taxReturns} today={today} />
      )}
      {activeTab === 'documents' && (
        <div className="space-y-4">
          {/* Documents the Drive tree below CANNOT show — Storage-backed
              formation/fax uploads and other sentinel pointers. It filters
              rather than listing everything, so a Drive-backed document no
              longer appears both here and in its folder (Luca, 2026-07-20).
              Passing the folder id lets it keep Drive-backed rows when
              FileManager would render only its empty state. */}
          <AccountDocumentsList
            documents={documents}
            accountHasDriveFolder={Boolean(account.drive_folder_id)}
          />
          <FileManager accountId={account.id} driveFolderId={account.drive_folder_id} isAdmin={true} />
        </div>
      )}
      {activeTab === 'emails' && (
        // All Gmail with this client: auto-matched (their contact addresses)
        // + manually linked threads (email_links — "Link to client" in the
        // inbox). Reuses the Portal Chats Email tab panel unchanged.
        <div className="flex h-[70vh] min-h-[420px] border rounded-lg overflow-hidden bg-white">
          <ThreadEmailPanel accountId={account.id} contactId={null} />
        </div>
      )}
      {activeTab === 'correspondence' && (
        <div className="p-4">
          <CorrespondenceUpload accountId={account.id} />
        </div>
      )}
      {activeTab === 'communications' && (
        <AccountCommunications accountId={account.id} />
      )}
      {activeTab === 'conversations' && (
        <ClientConversationsPanel entityType="account" entityId={account.id} />
      )}
      {activeTab === 'activity' && (
        <ActivityFeed kind="account" accountId={account.id} contactIds={contacts.map((c) => c.id)} />
      )}
      {activeTab === 'backend' && (
        <BackendActivityPanel kind="account" accountId={account.id} />
      )}
    </div>
  )
}

/* ── Installments Section ────────────────────────────── */

/**
 * WS-C: THE RAISE SURFACE for a setup fee paid in parts — a selector wired to machinery that is
 * already built, and deliberately nothing more (architect scope ruling, 2026-08-11: not an
 * authoring screen, not a new page). Renders NOTHING unless this account has a plan-bearing
 * offer, which is zero accounts today.
 *
 * The Raise button opens the SAME invoice dialog the installments use, prefilled with the part's
 * amount and the sanctioned description built server-side — and it carries the part's lineage
 * silently, which is what flips the action's dedup rule to part-identity and stamps the tranche
 * columns. Whether a part is raisable comes from the shared resolver via the plan-status route,
 * never re-derived here: the resolver and the database index agree about what "occupied" means,
 * and this section must not become a third opinion.
 */
function PaymentPlanPartsSection({ account }: { account: Account }) {
  const [plans, setPlans] = useState<Array<{
    offer_token: string
    client_name: string | null
    currency: string
    fully_settled: boolean
    commission_release: {
      eligible: boolean
      total_agreed: number
      total_received: number
      has_referrer: boolean
      has_partner: boolean
      released_at: string | null
    } | null
    parts: Array<{
      seq: number
      amount: number
      state: string
      raisable: boolean
      invoice_number: string | null
      superseded_count: number
      suggested_description: string
    }>
  }>>([])
  const [raiseTarget, setRaiseTarget] = useState<{
    offer_token: string
    seq: number
    amount: number
    currency: 'USD' | 'EUR'
    description: string
  } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  // ⛔ RELEASE — a human confirms the REAL numbers before anything is credited (Antonio,
  // 2026-08-13). `confirming` opens the panel with the numbers the server just returned;
  // `releasing` guards the button itself against a double-click firing two requests. The
  // server is the actual idempotency gate — this is purely to keep one click meaning one
  // request rather than a defense the money correctness depends on.
  const [confirmingRelease, setConfirmingRelease] = useState<string | null>(null)
  const [releasing, setReleasing] = useState(false)
  const [releaseOutcome, setReleaseOutcome] = useState<{ token: string; message: string; ok: boolean } | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`/api/offers/plan-status?account_id=${account.id}`)
      .then(async (res) => {
        if (!res.ok) return { plans: [] }
        return res.json()
      })
      .then((d: { plans?: typeof plans }) => {
        if (alive && Array.isArray(d.plans)) setPlans(d.plans)
      })
      .catch(() => { /* section simply does not render — staff lose a shortcut, nothing breaks */ })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, reloadKey])

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

  if (plans.length === 0) return null

  const stateLabel: Record<string, string> = {
    not_raised: 'Not raised',
    raised_unsent: 'Draft — client NOT told yet',
    awaiting_payment: 'Sent — awaiting payment',
    part_paid: 'Part-paid',
    paid: 'Paid',
  }

  // ⛔ THE ACTUAL RELEASE — one request, and the SERVER re-verifies eligibility from the
  // database before crediting anything; nothing here is trusted (Antonio, 2026-08-13).
  const handleReleaseCommission = async (offerToken: string) => {
    setReleasing(true)
    setReleaseOutcome(null)
    try {
      const res = await fetch('/api/offers/release-commission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer_token: offerToken }),
      })
      // Route response: { ok, already_released, message, referrer?, partner?, settlement }.
      // `message` is already the plain-English summary of whichever rail(s) fired — the referrer
      // credit, the partner payout, or both, since an offer can carry either or both.
      const d = await res.json().catch(() => ({})) as { ok?: boolean; message?: string; error?: string }
      if (!res.ok) {
        setReleaseOutcome({ token: offerToken, ok: false, message: d.error || d.message || 'Release failed.' })
        return
      }
      setReleaseOutcome({ token: offerToken, ok: true, message: d.message || 'Released.' })
      setConfirmingRelease(null)
      setReloadKey((k) => k + 1)
    } catch {
      setReleaseOutcome({ token: offerToken, ok: false, message: 'Release failed — network error.' })
    } finally {
      setReleasing(false)
    }
  }

  return (
    <>
      <div className="bg-white rounded-lg border p-5 space-y-4">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Partial Payment Schedule</h3>
        {plans.map((plan) => (
          <div key={plan.offer_token} className="space-y-2">
            <div className="text-xs text-muted-foreground">
              Offer {plan.offer_token}{plan.fully_settled ? ' — fully settled' : ''}
            </div>
            {plan.parts.map((part) => (
              <div key={part.seq} className="flex items-center justify-between gap-3 text-sm border rounded-md px-3 py-2">
                <div>
                  <div className="font-medium">
                    Part {part.seq} — {formatCurrency(part.amount, plan.currency)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {stateLabel[part.state] ?? part.state}
                    {part.invoice_number ? ` · ${part.invoice_number}` : ''}
                    {part.superseded_count > 0 ? ` · ${part.superseded_count} superseded` : ''}
                  </div>
                </div>
                {part.raisable && (
                  <button
                    type="button"
                    className="text-xs font-medium border rounded-md px-3 py-1.5 hover:bg-muted"
                    onClick={() =>
                      setRaiseTarget({
                        offer_token: plan.offer_token,
                        seq: part.seq,
                        amount: part.amount,
                        currency: plan.currency === 'EUR' ? 'EUR' : 'USD',
                        description: part.suggested_description,
                      })
                    }
                  >
                    Raise invoice
                  </button>
                )}
              </div>
            ))}

            {/* ⛔ RELEASE COMMISSION — only rendered when a referrer/partner exists on this
                offer. `eligible` (real cash, every part, computed server-side) gates the
                RECOMMENDATION only — the confirm panel opens regardless, so staff can see the
                real numbers and attempt a release even when this screen shows it as not yet
                settled (relevant for the documented false-negative — a known matcher recording
                gap can leave genuinely-paid money looking uncounted here). CORRECTED
                2026-08-14 (council pass — 3 reviewers independently flagged the prior wording):
                this is NOT a client-side override. The server re-checks eligibility itself on
                every request and refuses cleanly with a clear reason whenever it disagrees —
                there is no bypass parameter anywhere. The only real recovery path for a true
                false-negative is fixing the underlying invoice record first, then retrying. */}
            {plan.commission_release && (
              <div className={`rounded-md border px-3 py-2 text-sm ${plan.commission_release.released_at ? 'bg-zinc-50' : plan.commission_release.eligible ? 'bg-emerald-50 border-emerald-200' : 'bg-zinc-50'}`}>
                {/* ⛔ RELEASED, PERSISTENT (2026-08-14, bug-hunter, 6th pass) — without this branch
                    the account page kept showing "ready to release" with an active button forever
                    after a successful release; nothing on screen ever reflected that it had
                    already happened. Financially harmless either way (the release route's own
                    atomic claim refuses a repeat click cleanly), but staff had zero on-screen
                    signal — this is that signal. */}
                {plan.commission_release.released_at ? (
                  <div className="text-xs text-muted-foreground">
                    ✓ {plan.commission_release.has_partner ? "Partner's payout" : "Referrer's commission"} released on{' '}
                    {new Date(plan.commission_release.released_at).toLocaleDateString('en-US')}.
                  </div>
                ) : confirmingRelease === plan.offer_token ? (
                  <div className="space-y-2">
                    <div className="font-medium">
                      Release the {plan.commission_release.has_partner ? "partner's payout" : "referrer's commission"}?
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Total agreed: {formatCurrency(plan.commission_release.total_agreed, plan.currency)} ·
                      {' '}Real cash received: {formatCurrency(plan.commission_release.total_received, plan.currency)}
                      {!plan.commission_release.eligible && ' · ⚠️ Not detected as fully cash-settled — verify before releasing.'}
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={releasing}
                        className="text-xs font-medium rounded-md px-3 py-1.5 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                        onClick={() => handleReleaseCommission(plan.offer_token)}
                      >
                        {releasing ? 'Releasing…' : 'Confirm release'}
                      </button>
                      <button
                        type="button"
                        disabled={releasing}
                        className="text-xs font-medium rounded-md px-3 py-1.5 border hover:bg-muted"
                        onClick={() => setConfirmingRelease(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs">
                      {plan.commission_release.has_partner ? 'Managed partner' : 'Referrer'} on file
                      {plan.commission_release.eligible ? ' — fully paid in real cash. Ready to release.' : ' — not yet fully cash-settled.'}
                    </div>
                    <button
                      type="button"
                      className={`text-xs font-medium rounded-md px-3 py-1.5 ${plan.commission_release.eligible ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'border hover:bg-muted'}`}
                      onClick={() => { setConfirmingRelease(plan.offer_token); setReleaseOutcome(null) }}
                    >
                      Release commission
                    </button>
                  </div>
                )}
                {releaseOutcome && releaseOutcome.token === plan.offer_token && (
                  <div className={`text-xs mt-2 ${releaseOutcome.ok ? 'text-emerald-700' : 'text-red-600'}`}>
                    {releaseOutcome.message}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <InvoiceDialog
        key={raiseTarget ? `${raiseTarget.offer_token}:${raiseTarget.seq}` : 'closed'}
        open={raiseTarget !== null}
        onClose={() => { setRaiseTarget(null); setReloadKey((k) => k + 1) }}
        mode="invoice"
        defaultValues={raiseTarget ? {
          accountId: account.id,
          accountName: account.company_name,
          description: raiseTarget.description,
          currency: raiseTarget.currency,
          tranche: { offer_token: raiseTarget.offer_token, seq: raiseTarget.seq },
          items: [{
            description: raiseTarget.description,
            quantity: 1,
            unit_price: raiseTarget.amount,
            amount: raiseTarget.amount,
            sort_order: 0,
          }],
        } : undefined}
        onCreateInvoice={createInvoice}
        onSendInvoice={handleSendInvoice}
      />
    </>
  )
}

function InstallmentsSection({ account, payments, makeAccountSaver }: { account: Account; payments: Payment[]; makeAccountSaver: (field: string) => (val: string) => Promise<{ success: boolean; error?: string }> }) {
  const [openForInst, setOpenForInst] = useState<1 | 2 | null>(null)

  const year = new Date().getFullYear()

  // Resolve 1st installment invoice first
  const inst1Amount = account.installment_1_amount
  const inst1Currency = (account.installment_1_currency ?? 'USD') as 'USD' | 'EUR'
  const inst1Match = inst1Amount
    ? findInstallmentInvoice(payments, inst1Amount, inst1Currency, 'Installment 1 (Jan)', year, [])
    : null

  // Resolve 2nd installment, excluding the 1st match to avoid double-counting
  const inst2Amount = account.installment_2_amount
  const inst2Currency = (account.installment_2_currency ?? 'USD') as 'USD' | 'EUR'
  const excludeIds = inst1Match ? [inst1Match.id] : []
  const inst2Match = inst2Amount
    ? findInstallmentInvoice(payments, inst2Amount, inst2Currency, 'Installment 2 (Jun)', year, excludeIds)
    : null

  const dialogDefaults: InvoiceDialogDefaults | undefined = openForInst === 1
    ? {
        accountId: account.id,
        accountName: account.company_name,
        description: `1st Installment ${year}`,
        currency: inst1Currency,
        installment: 'Installment 1 (Jan)',
        items: [{
          description: `1st Installment ${year}`,
          quantity: 1,
          unit_price: inst1Amount ?? 0,
          amount: inst1Amount ?? 0,
          sort_order: 0,
        }],
      }
    : openForInst === 2
    ? {
        accountId: account.id,
        accountName: account.company_name,
        description: `2nd Installment ${year}`,
        currency: inst2Currency,
        installment: 'Installment 2 (Jun)',
        items: [{
          description: `2nd Installment ${year}`,
          quantity: 1,
          unit_price: inst2Amount ?? 0,
          amount: inst2Amount ?? 0,
          sort_order: 0,
        }],
      }
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

  return (
    <>
      <div className="bg-white rounded-lg border p-5 space-y-4">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Annual Installments</h3>
        <div className="grid gap-3 text-sm">
          <EditableField icon={CreditCard} label="1st Installment" value={inst1Amount?.toString() ?? ''} onSave={makeAccountSaver('installment_1_amount')} />
          <EditableField icon={Globe} label="1st Currency" value={inst1Currency} type="select" options={[{ label: 'USD', value: 'USD' }, { label: 'EUR', value: 'EUR' }]} onSave={makeAccountSaver('installment_1_currency')} />
          {inst1Amount && <InstallmentBadge match={inst1Match} onInvoice={inst1Match ? undefined : () => setOpenForInst(1)} />}
          <EditableField icon={CreditCard} label="2nd Installment" value={inst2Amount?.toString() ?? ''} onSave={makeAccountSaver('installment_2_amount')} />
          <EditableField icon={Globe} label="2nd Currency" value={inst2Currency} type="select" options={[{ label: 'USD', value: 'USD' }, { label: 'EUR', value: 'EUR' }]} onSave={makeAccountSaver('installment_2_currency')} />
          {inst2Amount && <InstallmentBadge match={inst2Match} onInvoice={inst2Match ? undefined : () => setOpenForInst(2)} />}
        </div>
      </div>

      <InvoiceDialog
        key={openForInst ?? 'closed'}
        open={openForInst !== null}
        onClose={() => setOpenForInst(null)}
        mode="invoice"
        defaultValues={dialogDefaults}
        onCreateInvoice={createInvoice}
        onSendInvoice={handleSendInvoice}
      />
    </>
  )
}

function findInstallmentInvoice(
  payments: Payment[],
  amount: number,
  currency: string,
  installmentLabel: 'Installment 1 (Jan)' | 'Installment 2 (Jun)',
  year: number,
  excludeIds: string[],
): Payment | null {
  const yearStr = String(year)
  return payments.find(p => {
    if (excludeIds.includes(p.id)) return false
    if (p.installment !== installmentLabel) return false
    if (!p.description?.includes(yearStr)) return false
    const invTotal = Number(p.total) || p.amount || 0
    const invCurr = p.amount_currency || 'USD'
    return Math.abs(invTotal - amount) < 2 && invCurr === currency && p.invoice_number && p.invoice_number !== '1.0' && p.invoice_number !== '2.0'
  }) ?? null
}

function InstallmentBadge({ match, onInvoice }: { match: Payment | null; onInvoice?: () => void }) {
  if (!match) {
    return (
      <div className="flex items-center gap-2 pl-6 text-xs">
        <span className="px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500">Not invoiced</span>
        {onInvoice && (
          <button
            onClick={onInvoice}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors text-[11px] font-medium border border-blue-200"
          >
            <Plus className="h-3 w-3" />
            Invoice
          </button>
        )}
      </div>
    )
  }
  const status = match.invoice_status ?? match.status ?? ''
  const isPaid = status === 'Paid'
  return (
    <div className="flex items-center gap-2 pl-6 text-xs">
      <span className="font-mono text-blue-600">{match.invoice_number}</span>
      <span className={cn('px-1.5 py-0.5 rounded', isPaid ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700')}>
        {isPaid ? 'Paid' : status}
      </span>
      {match.paid_date && <span className="text-muted-foreground">{formatDate(match.paid_date)}</span>}
    </div>
  )
}

/* ── Members Section (MMLLC only) ────────────────────────── */

type CrmMember = {
  id: string
  member_type: string
  full_name: string | null
  company_name: string | null
  email: string | null
  phone: string | null
  ein: string | null
  ownership_pct: number | null
  is_primary: boolean | null
  is_signer: boolean
  contact_id: string | null
  address_street: string | null
  address_city: string | null
  address_state: string | null
  address_zip: string | null
  address_country: string | null
  representative_name: string | null
  representative_email: string | null
  representative_phone: string | null
  representative_address_street: string | null
  representative_address_city: string | null
  representative_address_state: string | null
  representative_address_zip: string | null
  representative_address_country: string | null
}

type UpdateDBADetailsArg = Partial<{
  dba_name: string | null
  jurisdiction: string | null
  filed_date: string | null
  registration_number: string | null
  renewal_date: string | null
  renewal_period: string | null
  filing_fee: number | null
  notes: string | null
}>

const RENEWAL_PERIOD_OPTIONS = [
  { label: '—', value: '' },
  { label: 'None', value: 'none' },
  { label: '1-year', value: '1-year' },
  { label: '2-year', value: '2-year' },
  { label: '5-year', value: '5-year' },
  { label: '10-year', value: '10-year' },
]

function DBARow({
  accountId,
  d,
}: {
  accountId: string
  d: NonNullable<AccountDetailProps['dbaServiceDeliveries']>[number]
}) {
  const router = useRouter()
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // updated_at for optimistic locking — only the detail row has it; if a DBA
  // SD pre-dates the dba_details row (legacy), edits are disabled until the
  // row is backfilled via a save through the Add form.
  const detailId = d.detail_id
  const detailUpdatedAt = d.detail_updated_at
  const canEdit = Boolean(detailId && detailUpdatedAt)

  const makeSaver = (field: 'dba_name' | 'jurisdiction' | 'filed_date' | 'registration_number' | 'renewal_date' | 'renewal_period' | 'filing_fee' | 'notes') => {
    return async (value: string) => {
      if (!detailId || !detailUpdatedAt) {
        return { success: false, error: 'No DBA detail row to update' }
      }
      const updates: UpdateDBADetailsArg = {}
      if (field === 'filing_fee') {
        const n = value.trim() === '' ? null : Number(value)
        updates.filing_fee = n == null || Number.isNaN(n) ? null : n
      } else {
        updates[field] = value
      }
      const r = await updateDBADetails(detailId, updates, detailUpdatedAt)
      if (r.success) {
        toast.success('Saved')
        router.refresh()
      } else {
        toast.error(r.error ?? 'Failed to save')
      }
      return { success: r.success, error: r.error }
    }
  }

  const handleUploadClick = () => {
    fileRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!detailId) {
      toast.error('Save the DBA before uploading documents')
      e.target.value = ''
      return
    }
    setUploading(true)
    try {
      const storagePath = `crm-dba-uploads/${accountId}/${detailId}/${Date.now()}_${file.name}`
      // 1. Signed URL for Supabase Storage (bypass Vercel 4.5MB body limit).
      const sigRes = await fetch('/api/storage/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bucket: 'onboarding-uploads',
          path: storagePath,
          contentType: file.type || 'application/pdf',
        }),
      })
      if (!sigRes.ok) {
        const errBody = await sigRes.json().catch(() => ({}))
        throw new Error(errBody.error || 'Failed to get upload URL')
      }
      const { signedUrl } = await sigRes.json()
      if (!signedUrl) throw new Error('No signed URL returned')

      // 2. PUT the file directly to Supabase Storage.
      const putRes = await fetch(signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/pdf' },
        body: file,
      })
      if (!putRes.ok) throw new Error('File upload to storage failed')

      // 3. Register in CRM — uploads to Drive, runs OCR, auto-fills empty fields.
      const apiRes = await fetch(`/api/accounts/${accountId}/dba/${detailId}/upload-document`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storage_path: storagePath,
          file_name: file.name,
          mime_type: file.type || 'application/pdf',
        }),
      })
      const data = await apiRes.json()
      if (!apiRes.ok || !data.success) {
        throw new Error(data.detail || data.error || 'Upload failed')
      }
      toast.success(data.detail || 'DBA document uploaded')
      if (data.side_effects?.length) {
        toast.info(data.side_effects.join(' | '))
      }
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Upload failed — try again')
    } finally {
      setUploading(false)
      if (e.target) e.target.value = ''
    }
  }

  const displayName = d.dba_name ?? d.service_name ?? 'DBA'

  return (
    <div className="border border-zinc-100 rounded-md p-3 bg-zinc-50/40 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-sm truncate">{displayName}</p>
        </div>
        <div className="text-right text-xs text-muted-foreground shrink-0">
          {d.start_date && <p>Start {formatDate(d.start_date)}</p>}
          {d.end_date && <p>End {formatDate(d.end_date)}</p>}
        </div>
      </div>

      <div className="grid gap-1 sm:grid-cols-2">
        <EditableField icon={Briefcase} label="DBA Name" value={d.dba_name ?? ''} onSave={makeSaver('dba_name')} readOnly={!canEdit} />
        <EditableField icon={MapPin} label="Jurisdiction" value={d.jurisdiction ?? ''} onSave={makeSaver('jurisdiction')} readOnly={!canEdit} />
        <EditableField icon={Calendar} label="Filed Date" type="date" value={d.filed_date ?? ''} onSave={makeSaver('filed_date')} readOnly={!canEdit} />
        <EditableField icon={Hash} label="Reg. Number" value={d.registration_number ?? ''} onSave={makeSaver('registration_number')} readOnly={!canEdit} />
        <EditableField icon={Calendar} label="Renewal Date" type="date" value={d.renewal_date ?? ''} onSave={makeSaver('renewal_date')} readOnly={!canEdit} />
        <EditableField icon={Clock} label="Renewal Period" type="select" options={RENEWAL_PERIOD_OPTIONS} value={d.renewal_period ?? ''} onSave={makeSaver('renewal_period')} readOnly={!canEdit} />
        <EditableField icon={DollarSign} label="Filing Fee" value={d.filing_fee != null ? String(d.filing_fee) : ''} onSave={makeSaver('filing_fee')} readOnly={!canEdit} />
        <EditableField icon={FileText} label="Notes" type="textarea" value={d.detail_notes ?? ''} onSave={makeSaver('notes')} readOnly={!canEdit} />
      </div>

      <div className="flex items-center gap-2 pt-2 border-t border-zinc-100">
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/tiff,image/webp"
          className="hidden"
          onChange={handleFileChange}
        />
        <button
          type="button"
          onClick={handleUploadClick}
          disabled={uploading || !detailId}
          title={!detailId ? 'Save the DBA before uploading documents' : 'Upload a document for this DBA. OCR will try to auto-fill missing fields.'}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {uploading ? 'Uploading…' : 'Upload Document'}
        </button>
        {!detailId && (
          <span className="text-xs text-muted-foreground">Save the DBA first to enable upload</span>
        )}
      </div>
    </div>
  )
}

function DBASection({
  accountId,
  dbaServiceDeliveries,
  dbaStages,
}: {
  accountId: string
  dbaServiceDeliveries: NonNullable<AccountDetailProps['dbaServiceDeliveries']>
  dbaStages: PipelineStage[]
}) {
  const router = useRouter()
  const [showForm, setShowForm] = useState(false)
  const [dbaName, setDbaName] = useState('')
  const [jurisdiction, setJurisdiction] = useState('')
  const [filedDate, setFiledDate] = useState('')
  const [registrationNumber, setRegistrationNumber] = useState('')
  const [renewalDate, setRenewalDate] = useState('')
  const [renewalPeriod, setRenewalPeriod] = useState('')
  const [filingFee, setFilingFee] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const resetForm = () => {
    setDbaName('')
    setJurisdiction('')
    setFiledDate('')
    setRegistrationNumber('')
    setRenewalDate('')
    setRenewalPeriod('')
    setFilingFee('')
    setNotes('')
  }

  const handleAdd = async () => {
    const name = dbaName.trim()
    const juris = jurisdiction.trim()
    if (!name || !juris) {
      toast.error('DBA name and jurisdiction are required')
      return
    }
    const feeNum = filingFee.trim() === '' ? null : Number(filingFee)
    if (feeNum != null && Number.isNaN(feeNum)) {
      toast.error('Filing fee must be a number')
      return
    }
    setSaving(true)
    const result = await createDBA(accountId, {
      dba_name: name,
      jurisdiction: juris,
      filed_date: filedDate.trim() || null,
      registration_number: registrationNumber.trim() || null,
      renewal_date: renewalDate.trim() || null,
      renewal_period: renewalPeriod.trim() || null,
      filing_fee: feeNum,
      notes: notes.trim() || null,
    })
    setSaving(false)
    if (result.success) {
      toast.success('DBA created')
      resetForm()
      setShowForm(false)
      router.refresh()
    } else {
      toast.error(result.error ?? 'Failed to create DBA')
    }
  }

  return (
    <div className="bg-white rounded-lg border p-5 space-y-3 lg:col-span-2">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
          DBA / Trade Names{dbaServiceDeliveries.length > 0 ? ` (${dbaServiceDeliveries.length})` : ''}
        </h3>
        {!showForm && (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-zinc-50"
          >
            <Plus className="h-3.5 w-3.5" />
            Add DBA
          </button>
        )}
      </div>

      {showForm && (
        <div className="border border-zinc-200 rounded-md p-3 space-y-2 bg-zinc-50/40">
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">DBA Name *</label>
              <input
                type="text"
                value={dbaName}
                onChange={e => setDbaName(e.target.value)}
                placeholder="e.g. Acme Trading Co."
                className="w-full px-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={saving}
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">State / Jurisdiction *</label>
              <input
                type="text"
                value={jurisdiction}
                onChange={e => setJurisdiction(e.target.value)}
                placeholder="e.g. New York"
                className="w-full px-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={saving}
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Filed Date</label>
              <input
                type="date"
                value={filedDate}
                onChange={e => setFiledDate(e.target.value)}
                className="w-full px-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={saving}
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Registration Number</label>
              <input
                type="text"
                value={registrationNumber}
                onChange={e => setRegistrationNumber(e.target.value)}
                placeholder="Optional"
                className="w-full px-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={saving}
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Renewal Date</label>
              <input
                type="date"
                value={renewalDate}
                onChange={e => setRenewalDate(e.target.value)}
                className="w-full px-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={saving}
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Renewal Period</label>
              <select
                value={renewalPeriod}
                onChange={e => setRenewalPeriod(e.target.value)}
                className="w-full px-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={saving}
              >
                {RENEWAL_PERIOD_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Filing Fee</label>
              <input
                type="number"
                step="0.01"
                value={filingFee}
                onChange={e => setFilingFee(e.target.value)}
                placeholder="0.00"
                className="w-full px-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={saving}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Notes</label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Optional"
              className="w-full px-2 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={saving}
            />
          </div>
          <div className="flex gap-2 justify-end pt-1">
            <button
              type="button"
              onClick={() => {
                setShowForm(false)
                resetForm()
              }}
              disabled={saving}
              className="px-3 py-1.5 text-sm rounded-md border hover:bg-zinc-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAdd}
              disabled={saving || !dbaName.trim() || !jurisdiction.trim()}
              className="px-3 py-1.5 text-sm rounded-md bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {saving ? 'Creating…' : 'Create DBA'}
            </button>
          </div>
        </div>
      )}

      {dbaServiceDeliveries.length === 0 ? (
        !showForm && <p className="text-sm text-muted-foreground">No DBA registrations</p>
      ) : (
        <div className="space-y-3">
          {dbaServiceDeliveries.map(d => {
            const displayName = d.dba_name ?? d.service_name ?? 'DBA'
            const isActive = d.status !== 'completed' && d.status !== 'cancelled'
            return (
              <div key={d.id} className="space-y-2">
                <DBARow accountId={accountId} d={d} />
                {isActive && dbaStages.length > 0 ? (
                  <SdPipelineStepper
                    deliveryId={d.id}
                    serviceType="DBA"
                    serviceName={displayName}
                    currentStage={d.stage}
                    status={d.status ?? 'active'}
                    updatedAt={d.updated_at}
                    stages={dbaStages}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground pl-3">
                    {[d.stage, d.status].filter(Boolean).join(' · ') || '—'}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function MembersSection({ accountId, accountCompanyName, contacts, memberCount: initialMemberCount, accountUpdatedAt }: { accountId: string; accountCompanyName: string; contacts: Contact[]; memberCount: number | null; accountUpdatedAt: string }) {
  const [members, setMembers] = useState<CrmMember[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<Partial<CrmMember>>({})
  const [saving, setSaving] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [addType, setAddType] = useState<'individual' | 'company'>('individual')
  const [addDraft, setAddDraft] = useState<Record<string, string | number | null>>({})
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CrmMember | null>(null)
  const [sendingForm, setSendingForm] = useState(false)
  const [formRequest, setFormRequest] = useState<{ status: string; created_at: string; submitted_at: string | null } | null>(null)
  const [hasPrimaryContact, setHasPrimaryContact] = useState(true)
  const [memberCount, setMemberCount] = useState<number | null>(initialMemberCount)
  const [editingMemberCount, setEditingMemberCount] = useState(false)
  const [memberCountDraft, setMemberCountDraft] = useState('')
  const [savingMemberCount, setSavingMemberCount] = useState(false)

  const loadFormRequest = () => {
    fetch(`/api/accounts/${accountId}/member-info-form`)
      .then(r => r.json())
      .then(d => {
        setFormRequest(d.request ?? null)
        setHasPrimaryContact(d.has_primary_contact ?? true)
      })
      .catch(() => {})
  }

  const handleSendMemberInfoForm = async () => {
    setSendingForm(true)
    try {
      const res = await fetch(`/api/accounts/${accountId}/member-info-form`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to send form')
      toast.success(data.is_existing ? 'Form link re-sent via portal chat' : 'Member info form sent via portal chat')
      loadFormRequest()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send form')
    } finally {
      setSendingForm(false)
    }
  }

  useEffect(() => {
    setLoading(true)
    fetch(`/api/accounts/${accountId}/members`)
      .then(async r => {
        const d = await r.json()
        if (!r.ok) throw new Error(d.error || 'Failed to load members')
        setMembers(d.data ?? [])
      })
      .catch(() => toast.error('Failed to load members'))
      .finally(() => setLoading(false))
    loadFormRequest()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId])

  const displayName = (m: CrmMember) =>
    m.member_type === 'company' ? (m.company_name ?? '—') : (m.full_name ?? '—')

  const handleEdit = (m: CrmMember) => {
    setEditingId(m.id)
    setEditDraft({ ...m })
  }

  const handleSave = async () => {
    if (!editingId) return
    setSaving(true)
    try {
      const res = await fetch(`/api/accounts/${accountId}/members`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: editingId, ...editDraft }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to save')
      setMembers(prev => prev.map(m => m.id === editingId ? (data.data as CrmMember) : m))
      setEditingId(null)
      toast.success('Member updated')
      // What the SS-4 auto-refresh did with this edit — kept an explicit pick,
      // blocked on the flag count, or refused an orphaned signer. Silence here
      // is how conflicting staff actions go unnoticed (council major, 2026-08-11).
      const ss4Note = (data.ss4_refresh as { message?: string } | null | undefined)?.message
      if (ss4Note) toast.warning(ss4Note, { duration: 12000 })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleAdd = async () => {
    setAdding(true)
    setAddError(null)
    try {
      const body = addType === 'company'
        ? { member_type: 'company', member_company_name: addDraft.company_name, ...addDraft }
        : { member_type: 'individual', ...addDraft }
      const res = await fetch(`/api/accounts/${accountId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to add member')
      setMembers(prev => [...prev, data.data as CrmMember])
      setShowAddForm(false)
      setAddDraft({})
      toast.success('Member added')
      const addSs4Note = (data.ss4_refresh as { message?: string } | null | undefined)?.message
      if (addSs4Note) toast.warning(addSs4Note, { duration: 12000 })
    } catch (err) {
      // Show the plain-language reason right here in the form (persistent),
      // not just a toast that disappears.
      setAddError(err instanceof Error && err.message ? err.message : 'Could not add the member.')
    } finally {
      setAdding(false)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return { success: false, error: 'No member selected' }
    try {
      const res = await fetch(`/api/accounts/${accountId}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: deleteTarget.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to remove member')
      setMembers(prev => prev.filter(m => m.id !== deleteTarget.id))
      // Deleting the member who IS the SS-4 signer triggers the orphan alert
      // (link revoked, staff must pick) — that must reach the person deleting.
      const delSs4Note = (data.ss4_refresh as { message?: string } | null | undefined)?.message
      if (delSs4Note) toast.warning(delSs4Note, { duration: 12000 })
      return { success: true, message: `${displayName(deleteTarget)} removed` }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to remove' }
    }
  }

  const handleSaveMemberCount = async () => {
    setSavingMemberCount(true)
    try {
      const result = await updateAccountField(accountId, 'member_count', memberCountDraft, accountUpdatedAt)
      if (!result.success) throw new Error(result.error ?? 'Failed to save')
      const parsed = memberCountDraft.trim() === '' ? null : parseInt(memberCountDraft, 10)
      setMemberCount(isNaN(parsed as number) ? null : parsed)
      setEditingMemberCount(false)
      toast.success('Member count saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSavingMemberCount(false)
    }
  }

  const inputCls = 'w-full px-2.5 py-1.5 text-sm border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'

  // Contacts already linked to a member — excluded from the picker so we can't
  // link the same contact twice (which violates the one-member-per-contact rule).
  const linkedContactIds = new Set(members.map(m => m.contact_id).filter(Boolean) as string[])
  const availableContacts = contacts.filter(c => !linkedContactIds.has(c.id))

  if (loading) {
    return (
      <div className="bg-white rounded-lg border p-5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading members...
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
            Members ({members.length})
          </h3>
          {/* Official member count from SS-4 or manually set by staff */}
          <div className="flex items-center gap-1.5">
            {editingMemberCount ? (
              <>
                <input
                  type="number"
                  min={1}
                  max={99}
                  className="w-16 px-1.5 py-0.5 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                  value={memberCountDraft}
                  onChange={e => setMemberCountDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSaveMemberCount(); if (e.key === 'Escape') setEditingMemberCount(false) }}
                  autoFocus
                />
                <button onClick={handleSaveMemberCount} disabled={savingMemberCount} className="text-xs text-blue-600 hover:text-blue-700 font-medium disabled:opacity-50">
                  {savingMemberCount ? <Loader2 className="h-3 w-3 animate-spin inline" /> : 'Save'}
                </button>
                <button onClick={() => setEditingMemberCount(false)} className="text-xs text-zinc-400 hover:text-zinc-600">Cancel</button>
              </>
            ) : (
              <button
                onClick={() => { setMemberCountDraft(memberCount?.toString() ?? ''); setEditingMemberCount(true) }}
                className="text-xs text-zinc-500 hover:text-zinc-700 border border-dashed border-zinc-300 px-2 py-0.5 rounded"
                title="Official member count (from SS-4 or set manually). Used for OA generation validation."
              >
                {memberCount != null ? `${memberCount} official` : 'Set member count'}
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleSendMemberInfoForm}
              disabled={sendingForm || !hasPrimaryContact}
              className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 hover:text-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed"
              title={!hasPrimaryContact ? 'Primary member has no linked contact — link a contact to the primary member first' : 'Send member info form via portal chat'}
            >
              {sendingForm ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              {formRequest ? 'Resend' : 'Send Info Form'}
            </button>
            {!hasPrimaryContact && (
              <span className="text-xs text-amber-600">Primary member has no linked contact</span>
            )}
            {hasPrimaryContact && formRequest && (
              <span className="text-xs text-muted-foreground">
                {formRequest.submitted_at
                  ? `✓ Submitted ${new Date(formRequest.submitted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                  : `Sent ${new Date(formRequest.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                }
              </span>
            )}
          </div>
          <button
            onClick={() => { setShowAddForm(!showAddForm); setAddDraft({}) }}
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Member
          </button>
        </div>
      </div>

      {/* Add form */}
      {showAddForm && (
        <div className="p-3 bg-zinc-50 rounded-lg border space-y-3">
          <div className="flex gap-2">
            {(['individual', 'company'] as const).map(t => (
              <button
                key={t}
                onClick={() => { setAddType(t); setAddDraft({}) }}
                className={`text-xs px-2.5 py-1 rounded-full border font-medium transition-colors capitalize ${addType === t ? (t === 'company' ? 'bg-violet-100 text-violet-700 border-violet-200' : 'bg-blue-100 text-blue-700 border-blue-200') : 'bg-white text-zinc-500 border-zinc-200'}`}
              >{t}</button>
            ))}
          </div>
          {addType === 'individual' ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2">
                <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">Link existing contact (optional)</p>
                <select
                  className={inputCls}
                  value={String(addDraft.contact_id ?? '')}
                  onChange={e => {
                    const cid = e.target.value || null
                    if (!cid) {
                      setAddDraft(d => ({ ...d, contact_id: null }))
                      return
                    }
                    const picked = availableContacts.find(c => c.id === cid)
                    setAddDraft(d => ({
                      ...d,
                      contact_id: cid,
                      full_name: picked?.full_name ?? String(d.full_name ?? ''),
                      email: picked?.email ?? String(d.email ?? ''),
                      phone: picked?.phone ?? String(d.phone ?? ''),
                    }))
                  }}
                >
                  <option value="">— New person (type below) —</option>
                  {availableContacts.map(c => (
                    <option key={c.id} value={c.id}>
                      {(c.full_name || c.email || 'Unnamed contact')}{c.email && c.full_name ? ` (${c.email})` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <input placeholder="Full name *" className={inputCls} value={String(addDraft.full_name ?? '')} onChange={e => setAddDraft(d => ({ ...d, full_name: e.target.value }))} />
              <input placeholder="Email" className={inputCls} value={String(addDraft.email ?? '')} onChange={e => setAddDraft(d => ({ ...d, email: e.target.value }))} />
              <input placeholder="Phone" className={inputCls} value={String(addDraft.phone ?? '')} onChange={e => setAddDraft(d => ({ ...d, phone: e.target.value }))} />
              <input placeholder="Ownership %" type="number" min={0} max={100} className={inputCls} value={addDraft.ownership_pct ?? ''} onChange={e => setAddDraft(d => ({ ...d, ownership_pct: e.target.value === '' ? null : Number(e.target.value) }))} />
              <input placeholder="Street address" className={`${inputCls} col-span-2`} value={String(addDraft.address_street ?? '')} onChange={e => setAddDraft(d => ({ ...d, address_street: e.target.value }))} />
              <input placeholder="City" className={inputCls} value={String(addDraft.address_city ?? '')} onChange={e => setAddDraft(d => ({ ...d, address_city: e.target.value }))} />
              <input placeholder="State / Province" className={inputCls} value={String(addDraft.address_state ?? '')} onChange={e => setAddDraft(d => ({ ...d, address_state: e.target.value }))} />
              <input placeholder="ZIP / Postal code" className={inputCls} value={String(addDraft.address_zip ?? '')} onChange={e => setAddDraft(d => ({ ...d, address_zip: e.target.value }))} />
              <input placeholder="Country" className={inputCls} value={String(addDraft.address_country ?? '')} onChange={e => setAddDraft(d => ({ ...d, address_country: e.target.value }))} />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="Company name *" className={inputCls} value={String(addDraft.company_name ?? '')} onChange={e => setAddDraft(d => ({ ...d, company_name: e.target.value }))} />
              <input placeholder="EIN (optional)" className={inputCls} value={String(addDraft.ein ?? '')} onChange={e => setAddDraft(d => ({ ...d, ein: e.target.value }))} />
              <input placeholder="Representative name" className={inputCls} value={String(addDraft.representative_name ?? '')} onChange={e => setAddDraft(d => ({ ...d, representative_name: e.target.value }))} />
              <input placeholder="Representative email" className={inputCls} value={String(addDraft.representative_email ?? '')} onChange={e => setAddDraft(d => ({ ...d, representative_email: e.target.value }))} />
              <input placeholder="Representative phone" className={inputCls} value={String(addDraft.representative_phone ?? '')} onChange={e => setAddDraft(d => ({ ...d, representative_phone: e.target.value }))} />
              <input placeholder="Ownership %" type="number" min={0} max={100} className={inputCls} value={addDraft.ownership_pct ?? ''} onChange={e => setAddDraft(d => ({ ...d, ownership_pct: e.target.value === '' ? null : Number(e.target.value) }))} />
              <input placeholder="Rep street address" className={`${inputCls} col-span-2`} value={String(addDraft.representative_address_street ?? '')} onChange={e => setAddDraft(d => ({ ...d, representative_address_street: e.target.value }))} />
              <input placeholder="Rep city" className={inputCls} value={String(addDraft.representative_address_city ?? '')} onChange={e => setAddDraft(d => ({ ...d, representative_address_city: e.target.value }))} />
              <input placeholder="Rep state / province" className={inputCls} value={String(addDraft.representative_address_state ?? '')} onChange={e => setAddDraft(d => ({ ...d, representative_address_state: e.target.value }))} />
              <input placeholder="Rep ZIP / postal code" className={inputCls} value={String(addDraft.representative_address_zip ?? '')} onChange={e => setAddDraft(d => ({ ...d, representative_address_zip: e.target.value }))} />
              <input placeholder="Rep country" className={inputCls} value={String(addDraft.representative_address_country ?? '')} onChange={e => setAddDraft(d => ({ ...d, representative_address_country: e.target.value }))} />
            </div>
          )}
          {addError && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{addError}</span>
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={handleAdd} disabled={adding} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
              Add
            </button>
            <button onClick={() => { setShowAddForm(false); setAddDraft({}); setAddError(null) }} className="px-3 py-1.5 text-xs border rounded-md hover:bg-zinc-50">Cancel</button>
          </div>
        </div>
      )}

      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">No members on file</p>
      ) : (
        <div className="space-y-3">
          {members.map(m => (
            <div key={m.id} className="pb-3 border-b last:border-b-0 last:pb-0">
              {editingId !== m.id ? (
                /* ── Display row ── */
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${m.member_type === 'company' ? 'bg-violet-100' : 'bg-blue-100'}`}>
                      {m.member_type === 'company'
                        ? <Building2 className="h-3 w-3 text-violet-600" />
                        : <User className="h-3 w-3 text-blue-600" />}
                    </div>
                    {m.contact_id ? (
                      <Link href={`/contacts/${m.contact_id}`} className="font-medium text-sm text-blue-600 hover:underline">{displayName(m)}</Link>
                    ) : (
                      <span className="font-medium text-sm">{displayName(m)}</span>
                    )}
                    <div className="flex gap-1">
                      {m.is_primary && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-600 font-medium">Primary</span>}
                      {m.is_signer && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">Signer</span>}
                      {m.ownership_pct != null && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">{m.ownership_pct}%</span>}
                    </div>
                    <div className="ml-auto flex gap-0.5">
                      <button onClick={() => handleEdit(m)} className="p-1 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-700 transition-colors" title="Edit member">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setDeleteTarget(m)} className="p-1 rounded hover:bg-red-50 text-zinc-300 hover:text-red-500 transition-colors" title="Remove member">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  {m.member_type === 'individual' && (m.email || m.phone) && (
                    <p className="text-xs text-muted-foreground pl-8">{[m.email, m.phone].filter(Boolean).join(' · ')}</p>
                  )}
                  {m.member_type === 'individual' && (m.address_street || m.address_city || m.address_country) && (
                    <p className="text-xs text-muted-foreground pl-8">
                      {[m.address_street, m.address_city, m.address_state, m.address_zip, m.address_country].filter(Boolean).join(', ')}
                    </p>
                  )}
                  {m.member_type === 'company' && m.representative_name && (
                    <p className="text-xs text-muted-foreground pl-8">
                      Rep: {m.representative_name}{m.representative_email ? ` · ${m.representative_email}` : ''}{m.representative_phone ? ` · ${m.representative_phone}` : ''}
                    </p>
                  )}
                  {m.ein && <p className="text-xs text-muted-foreground pl-8">EIN: {m.ein}</p>}
                </div>
              ) : (
                /* ── Edit row ── */
                <div className="space-y-3 p-3 bg-zinc-50 rounded-lg">
                  {m.member_type === 'individual' ? (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">Full Name</p>
                        <input className={inputCls} value={String(editDraft.full_name ?? '')} onChange={e => setEditDraft(d => ({ ...d, full_name: e.target.value }))} />
                      </div>
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">Email</p>
                        <input className={inputCls} value={String(editDraft.email ?? '')} onChange={e => setEditDraft(d => ({ ...d, email: e.target.value }))} />
                      </div>
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">Phone</p>
                        <input className={inputCls} value={String(editDraft.phone ?? '')} onChange={e => setEditDraft(d => ({ ...d, phone: e.target.value }))} />
                      </div>
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">Ownership %</p>
                        <input type="number" min={0} max={100} className={inputCls} value={editDraft.ownership_pct ?? ''} onChange={e => setEditDraft(d => ({ ...d, ownership_pct: e.target.value === '' ? null : Number(e.target.value) }))} />
                      </div>
                      <div className="col-span-2">
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">Street Address</p>
                        <input className={inputCls} value={String(editDraft.address_street ?? '')} onChange={e => setEditDraft(d => ({ ...d, address_street: e.target.value }))} />
                      </div>
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">City</p>
                        <input className={inputCls} value={String(editDraft.address_city ?? '')} onChange={e => setEditDraft(d => ({ ...d, address_city: e.target.value }))} />
                      </div>
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">State / Province</p>
                        <input className={inputCls} value={String(editDraft.address_state ?? '')} onChange={e => setEditDraft(d => ({ ...d, address_state: e.target.value }))} />
                      </div>
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">ZIP / Postal Code</p>
                        <input className={inputCls} value={String(editDraft.address_zip ?? '')} onChange={e => setEditDraft(d => ({ ...d, address_zip: e.target.value }))} />
                      </div>
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">Country</p>
                        <input className={inputCls} value={String(editDraft.address_country ?? '')} onChange={e => setEditDraft(d => ({ ...d, address_country: e.target.value }))} />
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">Company Name</p>
                        <input className={inputCls} value={String(editDraft.company_name ?? '')} onChange={e => setEditDraft(d => ({ ...d, company_name: e.target.value }))} />
                      </div>
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">EIN</p>
                        <input className={inputCls} value={String(editDraft.ein ?? '')} onChange={e => setEditDraft(d => ({ ...d, ein: e.target.value }))} />
                      </div>
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">Rep Name</p>
                        <input className={inputCls} value={String(editDraft.representative_name ?? '')} onChange={e => setEditDraft(d => ({ ...d, representative_name: e.target.value }))} />
                      </div>
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">Rep Email</p>
                        <input className={inputCls} value={String(editDraft.representative_email ?? '')} onChange={e => setEditDraft(d => ({ ...d, representative_email: e.target.value }))} />
                      </div>
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">Rep Phone</p>
                        <input className={inputCls} value={String(editDraft.representative_phone ?? '')} onChange={e => setEditDraft(d => ({ ...d, representative_phone: e.target.value }))} />
                      </div>
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">Ownership %</p>
                        <input type="number" min={0} max={100} className={inputCls} value={editDraft.ownership_pct ?? ''} onChange={e => setEditDraft(d => ({ ...d, ownership_pct: e.target.value === '' ? null : Number(e.target.value) }))} />
                      </div>
                      <div className="col-span-2">
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">Rep Street Address</p>
                        <input className={inputCls} value={String(editDraft.representative_address_street ?? '')} onChange={e => setEditDraft(d => ({ ...d, representative_address_street: e.target.value }))} />
                      </div>
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">Rep City</p>
                        <input className={inputCls} value={String(editDraft.representative_address_city ?? '')} onChange={e => setEditDraft(d => ({ ...d, representative_address_city: e.target.value }))} />
                      </div>
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">Rep State / Province</p>
                        <input className={inputCls} value={String(editDraft.representative_address_state ?? '')} onChange={e => setEditDraft(d => ({ ...d, representative_address_state: e.target.value }))} />
                      </div>
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">Rep ZIP / Postal Code</p>
                        <input className={inputCls} value={String(editDraft.representative_address_zip ?? '')} onChange={e => setEditDraft(d => ({ ...d, representative_address_zip: e.target.value }))} />
                      </div>
                      <div>
                        <p className="text-[11px] text-zinc-500 uppercase font-medium tracking-wide mb-0.5">Rep Country</p>
                        <input className={inputCls} value={String(editDraft.representative_address_country ?? '')} onChange={e => setEditDraft(d => ({ ...d, representative_address_country: e.target.value }))} />
                      </div>
                    </div>
                  )}
                  <div className="flex items-center gap-4 text-sm">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox" checked={editDraft.is_primary ?? false} onChange={e => setEditDraft(d => ({ ...d, is_primary: e.target.checked }))} className="rounded border-zinc-300" />
                      Primary
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox" checked={editDraft.is_signer ?? false} onChange={e => setEditDraft(d => ({ ...d, is_signer: e.target.checked }))} className="rounded border-zinc-300" />
                      SS-4 Signer
                    </label>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={handleSave} disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
                      {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      Save
                    </button>
                    <button onClick={() => setEditingId(null)} className="px-3 py-1.5 text-xs border rounded-md hover:bg-zinc-50">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDestructiveDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Remove Member"
        description={deleteTarget ? `Remove ${displayName(deleteTarget)} from ${accountCompanyName}?` : undefined}
        severity="red"
        staticPreview={deleteTarget ? {
          affected: { member: 1 },
          items: [{ label: displayName(deleteTarget), details: [deleteTarget.member_type, deleteTarget.ownership_pct != null ? `${deleteTarget.ownership_pct}% ownership` : ''].filter(Boolean) }],
          warnings: ['Only the membership entry is removed — the contact record itself is not deleted.'],
        } : undefined}
        confirmLabel="Remove"
        onConfirm={handleDeleteConfirm}
      />
    </div>
  )
}

/* ── Panoramica Tab ───────────────────────────────────── */

function PanoramicaTab({ account, contacts, deals, payments, isAdmin: _isAdmin, partnerName, onOpenStatusDialog, dbaServiceDeliveries = [], stagesByServiceType = {} }: { account: Account; contacts: Contact[]; deals: Deal[]; payments: Payment[]; isAdmin: boolean; partnerName: string | null; onOpenStatusDialog: () => void; dbaServiceDeliveries?: NonNullable<AccountDetailProps['dbaServiceDeliveries']>; stagesByServiceType?: Record<string, PipelineStage[]> }) {
  const router = useRouter()
  const [noteText, setNoteText] = useState('')
  const [addingNote, setAddingNote] = useState(false)

  const makeAccountSaver = (field: string) => async (value: string) => {
    const result = await updateAccountField(account.id, field, value, account.updated_at)
    if (result.success) toast.success('Saved')
    else toast.error(result.error ?? 'Failed')
    return result
  }

  const makeContactSaver = (contactId: string, field: string, contactUpdatedAt: string) => async (value: string) => {
    const result = await updateContactField(contactId, field, value, contactUpdatedAt, account.id)
    if (result.success) toast.success('Saved')
    else toast.error(result.error ?? 'Failed')
    return result
  }

  const handleAddNote = async () => {
    if (!noteText.trim()) return
    setAddingNote(true)
    const result = await addAccountNote(account.id, noteText, account.updated_at)
    setAddingNote(false)
    if (result.success) {
      toast.success('Note added')
      setNoteText('')
    } else {
      toast.error(result.error ?? 'Failed')
    }
  }

  const ENTITY_OPTIONS = [
    { label: 'Single Member LLC', value: 'Single Member LLC' },
    { label: 'Multi Member LLC', value: 'Multi Member LLC' },
    { label: 'C-Corp Elected', value: 'C-Corp Elected' },
    { label: 'Corporation', value: 'Corporation' },
    { label: 'Partnership', value: 'Partnership' },
  ]

  const ACCOUNT_TYPE_OPTIONS = ACCOUNT_TYPE.map(t => ({ label: t, value: t }))

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Company Info */}
      <div className="bg-white rounded-lg border p-5 space-y-4">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Company Info</h3>
        <div className="grid gap-3 text-sm">
          <EditableField icon={Briefcase} label="Account Type" value={account.account_type ?? ''} type="select" options={ACCOUNT_TYPE_OPTIONS} onSave={makeAccountSaver('account_type')} />
          <div className="flex items-center gap-2 group">
            <Shield className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground min-w-[80px]">Status</span>
            <span className="flex-1">{account.status}</span>
            <button
              type="button"
              onClick={onOpenStatusDialog}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-zinc-100 rounded"
              aria-label="Change Status"
              title="Change Status"
            >
              <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>
          <EditableField icon={Building2} label="Entity Type" value={account.entity_type ?? ''} type="select" options={ENTITY_OPTIONS} onSave={makeAccountSaver('entity_type')} />
          <EditableField icon={Users} label="Member Structure" value={account.member_structure ?? ''} type="select" options={[{ label: 'Single Member', value: 'single_member' }, { label: 'Multi Member', value: 'multi_member' }]} onSave={makeAccountSaver('member_structure')} />
          <EditableField icon={MapPin} label="State" value={account.state_of_formation ?? ''} onSave={makeAccountSaver('state_of_formation')} />
          <EditableField icon={Calendar} label="Formation" value={account.formation_date ?? ''} type="date" onSave={makeAccountSaver('formation_date')} />
          <EditableField icon={Calendar} label="Client Since" value={account.client_since ?? ''} type="date" onSave={makeAccountSaver('client_since')} />
          <EditableField icon={Calendar} label="RA Switch Date" value={account.ra_switch_date ?? ''} type="date" onSave={makeAccountSaver('ra_switch_date')} />
          <EditableField icon={Shield} label="EIN" value={account.ein_number ?? ''} onSave={makeAccountSaver('ein_number')} />
          <EditableField icon={Mail} label="Business Email" value={account.communication_email ?? ''} onSave={makeAccountSaver('communication_email')} />
          <EditableField icon={FileText} label="Filing ID" value={account.filing_id ?? ''} onSave={makeAccountSaver('filing_id')} />

          {/* Address Registry — structured FK links */}
          <div className="border-t pt-3 mt-1 space-y-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Address Registry</p>
            <div>
              <p className="text-xs text-zinc-500 mb-1">Legal Address</p>
              <AddressPicker
                accountId={account.id}
                accountUpdatedAt={account.updated_at}
                kind="business_legal"
                value={account.business_legal_address_id ?? null}
                verified={account.legal_link_verified ?? false}
                onChange={() => router.refresh()}
              />
            </div>
            <div>
              <p className="text-xs text-zinc-500 mb-1">Mailing Address</p>
              <AddressPicker
                accountId={account.id}
                accountUpdatedAt={account.updated_at}
                kind="business_mailing"
                value={account.business_mailing_address_id ?? null}
                verified={account.mailing_link_verified ?? false}
                onChange={() => router.refresh()}
              />
            </div>
            <div>
              <p className="text-xs text-zinc-500 mb-1">Registered Agent</p>
              <RAPicker
                accountId={account.id}
                accountUpdatedAt={account.updated_at}
                value={account.registered_agent_id ?? null}
                verified={account.ra_link_verified ?? false}
                onChange={() => router.refresh()}
              />
            </div>
          </div>

          {account.gdrive_folder_url && (
            <div className="flex items-center gap-2">
              <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
              <a href={account.gdrive_folder_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline text-sm">
                Google Drive Folder
              </a>
            </div>
          )}
          <div className="border-t pt-3 mt-1">
            {partnerName && account.partner_id ? (
              <>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Partnership</p>
                <Link href={`/partners/${account.partner_id}`} className="flex items-center gap-2 p-3 bg-blue-50 rounded-lg border border-blue-200 hover:bg-blue-100 transition-colors group">
                  <Users className="h-5 w-5 text-blue-600 shrink-0" />
                  <div>
                    <div className="text-sm font-medium text-blue-800 group-hover:underline">Managed by {partnerName}</div>
                    <div className="text-xs text-blue-600">Click to view partner details</div>
                  </div>
                </Link>
              </>
            ) : (
              <>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Referral</p>
                <div className="grid gap-3">
                  <EditableField icon={Users} label="Referrer" value={account.referrer ?? ''} onSave={makeAccountSaver('referrer')} />
                  <EditableField icon={CreditCard} label="Commission %" value={account.referral_commission_pct != null ? String(account.referral_commission_pct) : ''} onSave={makeAccountSaver('referral_commission_pct')} />
                  <EditableField icon={FileText} label="Referral Status" value={account.referral_status ?? ''} type="select" options={[{label: '—', value: ''}, {label: 'Pending', value: 'pending'}, {label: 'Converted', value: 'converted'}, {label: 'Credited', value: 'credited'}, {label: 'Paid', value: 'paid'}]} onSave={makeAccountSaver('referral_status')} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Notification Center roll-up: What's New + To-Do + Workflow for this account */}
      <EntityActivitySummary accountId={account.id} />

      {/* Referrals GIVEN by this client (company or its people) — renders only when there are any */}
      <ReferralsGivenCard accountId={account.id} />

      {/* Billing — only for Client-type accounts (vendors/tenants/leads do not have annual installments) */}
      {account.account_type === 'Client' && (
        <>
          <PaymentPlanPartsSection account={account} />
          <InstallmentsSection account={account} payments={payments} makeAccountSaver={makeAccountSaver} />
        </>
      )}

      {/* Contacts */}
      <ContactsSection
        contacts={contacts}
        account={account}
        makeContactSaver={makeContactSaver}
      />

      {/* Members — any multi-member account (MMLLC or C-Corp Elected with multiple members) */}
      {account.member_structure === 'multi_member' && (
        <MembersSection accountId={account.id} accountCompanyName={account.company_name} contacts={contacts} memberCount={account.member_count ?? null} accountUpdatedAt={account.updated_at} />
      )}

      {/* Notes */}
      <div className="bg-white rounded-lg border p-5 space-y-3 lg:col-span-2">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Notes</h3>
        {account.notes && (
          <p className="text-sm whitespace-pre-wrap bg-zinc-50 p-3 rounded-md">{account.notes}</p>
        )}
        <div className="flex gap-2">
          <textarea
            value={noteText}
            onChange={e => setNoteText(e.target.value)}
            placeholder="Add a note..."
            rows={2}
            className="flex-1 px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
          <button
            onClick={handleAddNote}
            disabled={addingNote || !noteText.trim()}
            className="px-3 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 self-end"
          >
            {addingNote ? 'Adding...' : 'Add'}
          </button>
        </div>
        {!account.notes && (
          <p className="text-sm text-muted-foreground">No notes</p>
        )}
      </div>

      {/* DBA / Trade Names — always visible. Shows existing DBA service
          deliveries when present, with the pipeline stepper inline so the
          stage can be advanced from the Overview tab. */}
      <DBASection
        accountId={account.id}
        dbaServiceDeliveries={dbaServiceDeliveries}
        dbaStages={stagesByServiceType['DBA'] ?? []}
      />

      {/* Deals */}
      {deals.length > 0 && (
        <div className="bg-white rounded-lg border p-5 space-y-4 lg:col-span-2">
          <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
            Deals ({deals.length})
          </h3>
          <div className="space-y-2">
            {deals.map(d => (
              <div key={d.id} className="flex items-center justify-between py-2 border-b last:border-b-0 text-sm">
                <div>
                  <p className="font-medium">{d.deal_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {d.stage} · {d.deal_category ?? d.deal_type ?? '\u2014'}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-medium">{formatCurrency(d.amount, d.amount_currency)}</p>
                  <p className="text-xs text-muted-foreground">{formatDate(d.close_date)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function _InfoRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground min-w-[100px]">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

/* ── Servizi Tab ───────────────────────────────────── */

function ServiziTab({
  services,
  today,
  accountId,
  accountType,
  stepperDeliveries,
  stagesByServiceType,
  payments,
  flows = [],
}: {
  services: Service[]
  today: string
  accountId: string
  accountType: string | null
  stepperDeliveries: ServiceDeliveryForStepper[]
  stagesByServiceType: Record<string, PipelineStage[]>
  payments: Payment[]
  flows?: ResolvedFlow[]
}) {
  const router = useRouter()
  const [showAddService, setShowAddService] = useState(false)

  const active = stepperDeliveries.filter(d => d.status !== 'cancelled' && d.status !== 'completed')
  const done = stepperDeliveries.filter(d => d.status === 'cancelled' || d.status === 'completed')

  // Match invoice to a delivery: find the payment whose description matches
  // the service_type (Phase 9 auto-invoices use service_type as description).
  // If multiple exist (re-issues), take the most recent by issue_date.
  function invoiceFor(sd: ServiceDeliveryForStepper): Payment | undefined {
    return payments
      .filter(p => p.description === sd.service_type && p.invoice_number)
      .sort((a, b) =>
        (b.issue_date ?? b.invoice_date ?? b.due_date ?? '').localeCompare(
          a.issue_date ?? a.invoice_date ?? a.due_date ?? '',
        ),
      )[0]
  }

  return (
    <div className="space-y-6">
      {flows.length > 0 && (
        <div className="pb-2 border-b border-zinc-100">
          <FlowChips flows={flows} />
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
          Active ({active.length})
        </h3>
        <button
          onClick={() => setShowAddService(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-md hover:bg-zinc-50"
        >
          <Plus className="h-3.5 w-3.5" /> Add Service
        </button>
      </div>

      {active.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active services.</p>
      ) : (
        <div className="space-y-3">
          {active.map(sd => {
            const stages = stagesByServiceType[sd.service_type] ?? []
            const invoice = invoiceFor(sd)
            return (
              <div key={sd.id} className="bg-white rounded-lg border border-zinc-200 p-4 space-y-3">
                {/* Header: service name + status badge */}
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="font-medium text-zinc-900">{sd.service_name || sd.service_type}</span>
                    {sd.service_name && sd.service_name !== sd.service_type && (
                      <span className="text-xs text-zinc-500 ml-2">{sd.service_type}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 capitalize">
                      {sd.status}
                    </span>
                    <DeactivateServiceButton
                      deliveryId={sd.id}
                      serviceType={sd.service_type}
                      serviceName={sd.service_name || sd.service_type}
                      updatedAt={sd.updated_at}
                      accountType={accountType}
                    />
                  </div>
                </div>

                {/* Stage stepper — fully driven by pipeline_stages from DB */}
                {stages.length > 0 ? (
                  <SdPipelineStepper
                    deliveryId={sd.id}
                    serviceType={sd.service_type}
                    serviceName={sd.service_name || sd.service_type}
                    currentStage={sd.stage}
                    status={sd.status}
                    updatedAt={sd.updated_at}
                    stages={stages}
                  />
                ) : (
                  <p className="text-xs text-zinc-400 italic">No pipeline stages configured for this service.</p>
                )}

                {/* Invoice row */}
                <div className="flex items-center justify-between text-xs pt-2 border-t border-zinc-100">
                  {invoice ? (
                    <>
                      <span className="text-zinc-600 font-mono">
                        {invoice.invoice_number}
                        {invoice.amount != null && ` · ${formatCurrency(invoice.amount, invoice.amount_currency)}`}
                        {` · ${invoice.invoice_status ?? invoice.status ?? 'Pending'}`}
                      </span>
                      {invoice.sent_at ? (
                        <span className="text-zinc-400">Sent {new Date(invoice.sent_at).toLocaleDateString()}</span>
                      ) : (
                        <span className="text-amber-600 font-medium">Not sent to client yet</span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="text-zinc-400 italic">No invoice issued</span>
                      <button
                        onClick={() => router.push(`/accounts/${accountId}#payments`)}
                        className="text-blue-600 hover:underline"
                      >
                        Issue Invoice →
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {done.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
            Completed / Cancelled ({done.length})
          </h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {done.map(sd => {
              const legacy = services.find(s => s.id === sd.id)
              if (legacy) return <ServiceCard key={sd.id} service={legacy} today={today} />
              return (
                <div key={sd.id} className="bg-white rounded-lg border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">{sd.service_name || sd.service_type}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 capitalize shrink-0">{sd.status}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{sd.service_type}</p>
                  {sd.status === 'cancelled' && (
                    <div className="mt-2 pt-2 border-t border-zinc-100 flex justify-end">
                      <ReactivateServiceButton
                        deliveryId={sd.id}
                        serviceName={sd.service_name || sd.service_type}
                        updatedAt={sd.updated_at}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <AddServiceDialog
        open={showAddService}
        onClose={() => { setShowAddService(false); router.refresh() }}
        accountId={accountId}
        existingTypes={stepperDeliveries.map(s => s.service_type)}
      />
    </div>
  )
}

function EINReceivedDialog({ open, onClose, accountId, companyName }: {
  open: boolean; onClose: () => void; accountId: string; companyName: string
}) {
  const [einValue, setEinValue] = useState('')
  const [driveFileId, setDriveFileId] = useState('')
  const [recording, setRecording] = useState(false)

  if (!open) return null

  const handleRecord = async () => {
    if (!einValue.trim()) { toast.error('EIN is required'); return }
    setRecording(true)
    const res = await fetch('/api/crm/admin-actions/record-ein-received', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: accountId,
        ein_number: einValue.trim(),
        drive_file_id: driveFileId.trim() || undefined,
      }),
    })
    const data = await res.json().catch(() => ({}))
    setRecording(false)
    if (data.success) {
      toast.success(`EIN ${data.ein_number} recorded — tier upgraded to active`)
      setEinValue('')
      setDriveFileId('')
      onClose()
    } else {
      toast.error(data.error ?? 'Failed to record EIN')
    }
  }

  const handleClose = () => { setEinValue(''); setDriveFileId(''); onClose() }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={handleClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <h2 className="text-lg font-semibold">Record EIN Received</h2>
            <button onClick={handleClose} className="p-1 rounded hover:bg-zinc-100"><X className="h-5 w-5" /></button>
          </div>
          <div className="px-6 py-4 space-y-4">
            <p className="text-sm text-muted-foreground">{companyName}</p>
            <div>
              <label className="block text-sm font-medium mb-1">EIN Number *</label>
              <input
                type="text"
                value={einValue}
                onChange={e => setEinValue(e.target.value)}
                placeholder="30-1482516"
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <p className="text-xs text-muted-foreground mt-1">9 digits, with or without dash</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Drive File ID (optional)</label>
              <input
                type="text"
                value={driveFileId}
                onChange={e => setDriveFileId(e.target.value)}
                placeholder="Google Drive file ID of EIN letter"
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
          </div>
          <div className="px-6 py-4 border-t flex justify-end gap-2">
            <button onClick={handleClose} className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50">Cancel</button>
            <button
              onClick={handleRecord}
              disabled={recording || !einValue.trim()}
              className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2"
            >
              {recording && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {recording ? 'Processing…' : 'Record EIN'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

interface ServiceCatalogOption {
  id: string
  name: string
  pipeline: string | null
}

function AddServiceDialog({ open, onClose, accountId, existingTypes }: {
  open: boolean; onClose: () => void; accountId: string; existingTypes: string[]
}) {
  const [serviceType, setServiceType] = useState('')
  const [notes, setNotes] = useState('')
  const [creating, setCreating] = useState(false)
  const [skipInvoice, setSkipInvoice] = useState(false)
  const [options, setOptions] = useState<ServiceCatalogOption[]>([])
  const [loadingOptions, setLoadingOptions] = useState(false)

  // Load available service types from the catalog when the dialog opens.
  // Filtered to services with a pipeline (multi-stage lifecycle) — addons
  // without a pipeline have no stages so createSD would fail.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadingOptions(true)
    fetch('/api/service-catalog')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        const list = (data.services ?? []) as Array<ServiceCatalogOption & { active?: boolean }>
        // Active services only, with a pipeline name (SD-eligible).
        const filtered = list
          .filter((s) => s.active !== false && typeof s.pipeline === 'string' && s.pipeline.trim().length > 0)
          .map((s) => ({ id: s.id, name: s.name, pipeline: s.pipeline }))
          .sort((a, b) => a.name.localeCompare(b.name))
        setOptions(filtered)
      })
      .catch(() => {
        if (!cancelled) toast.error('Failed to load service catalog')
      })
      .finally(() => {
        if (!cancelled) setLoadingOptions(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  if (!open) return null

  const handleCreate = async () => {
    if (!serviceType) { toast.error('Select a service type'); return }
    setCreating(true)
    const res = await fetch('/api/crm/admin-actions/create-service', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: accountId, service_type: serviceType, notes: notes.trim() || undefined, skip_invoice: skipInvoice }),
    })
    const data = await res.json()
    setCreating(false)
    if (data.success) {
      toast.success(skipInvoice ? `${serviceType} created (no invoice)` : `${serviceType} created`)
      setServiceType('')
      setNotes('')
      setSkipInvoice(false)
      onClose()
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
            <h2 className="text-lg font-semibold">Add Service</h2>
            <button onClick={handleClose} className="p-1 rounded hover:bg-zinc-100"><X className="h-5 w-5" /></button>
          </div>
          <div className="px-6 py-4 space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Service Type *</label>
              <select value={serviceType} onChange={e => setServiceType(e.target.value)}
                disabled={loadingOptions}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-zinc-50">
                <option value="">{loadingOptions ? 'Loading…' : 'Select...'}</option>
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
                  No catalog services with a pipeline. Add one in Service Catalog first.
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Notes</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                placeholder="Optional notes..."
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
            </div>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={skipInvoice} onChange={e => setSkipInvoice(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-zinc-300" />
              <span>
                Already paid — don&apos;t create an invoice
                <span className="block text-xs text-muted-foreground">Tick this when the service was already paid (e.g. bundled into another offer). Otherwise a draft invoice is auto-created.</span>
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

function ServiceCard({ service: s, today }: { service: Service; today: string }) {
  const isBlocked = s.blocked_waiting_external === true
  const hasSla = s.sla_due_date && s.status !== 'Completed' && s.status !== 'Cancelled'
  let slaDays: number | null = null
  if (hasSla) {
    slaDays = differenceInDays(parseISO(s.sla_due_date!), parseISO(today))
  }

  return (
    <div className={cn(
      'bg-white rounded-lg border p-3 text-sm',
      isBlocked && 'border-red-200 bg-red-50/50'
    )}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="font-medium truncate">{s.service_name}</span>
        <span className={cn('text-xs px-1.5 py-0.5 rounded shrink-0', SERVICE_STATUS_COLORS[s.status ?? ''] ?? 'bg-zinc-100')}>
          {s.status}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{s.service_type}</p>
      <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          {s.current_step != null && s.total_steps != null && (
            <span>Step {s.current_step}/{s.total_steps}</span>
          )}
          {isBlocked && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-700">
              BLOCKED
            </span>
          )}
        </div>
        {slaDays !== null && (
          <span className={cn(
            'flex items-center gap-1',
            slaDays < 0 ? 'text-red-600 font-medium' :
            slaDays <= 3 ? 'text-amber-600' : ''
          )}>
            <Clock className="h-3 w-3" />
            {slaDays < 0 ? `${Math.abs(slaDays)}d overdue` :
             slaDays === 0 ? 'Due today' : `${slaDays}d`}
          </span>
        )}
      </div>
      {s.amount != null && (
        <p className="text-xs text-muted-foreground mt-1">
          {formatCurrency(s.amount, s.amount_currency)}
          {s.billing_type && ` · ${s.billing_type}`}
        </p>
      )}
    </div>
  )
}

/* ── Pagamenti Tab ───────────────────────────────────── */

function PagamentiTab({ payments, today, account }: {
  payments: Payment[]
  today: string
  account: { id: string; updated_at: string; dunning_reminder_1_days?: number | null; dunning_reminder_2_days?: number | null; dunning_pause?: boolean | null; dunning_pause_until?: string | null; dunning_pause_reason?: string | null }
}) {
  // Split into invoiced (unified system) vs legacy tracking records
  const invoiced = payments.filter(p => p.invoice_number && p.invoice_number !== '1.0' && p.invoice_number !== '2.0')
  const legacy = payments.filter(p => !p.invoice_number || p.invoice_number === '1.0' || p.invoice_number === '2.0')

  // Group invoiced by status
  const invoiceStatus = (p: Payment) => p.invoice_status ?? p.status ?? ''
  const overdue = invoiced.filter(p => invoiceStatus(p) === 'Overdue' || (invoiceStatus(p) === 'Sent' && p.due_date && p.due_date < today))
  const pending = invoiced.filter(p => ['Sent', 'Draft', 'Partial'].includes(invoiceStatus(p)) && !(p.due_date && p.due_date < today))
  const paid = invoiced.filter(p => invoiceStatus(p) === 'Paid')
  const otherInvoiced = invoiced.filter(p => !overdue.includes(p) && !pending.includes(p) && !paid.includes(p))

  const dunningSave = (field: 'dunning_reminder_1_days' | 'dunning_reminder_2_days' | 'dunning_pause' | 'dunning_pause_until' | 'dunning_pause_reason') =>
    async (v: string) => {
      const r = await updateAccountField(account.id, field, v, account.updated_at)
      if (r.success) toast.success('Reminder settings saved')
      else toast.error(r.error ?? 'Failed to save')
      return r
    }

  // Account-level reminder pause: legacy boolean OR active dated pause
  // ("client promised to pay by X" — expires by itself). Passed down so each
  // row's Send Reminder can warn-and-confirm instead of silently sending.
  const pauseUntilActive = !!account.dunning_pause_until && account.dunning_pause_until >= today
  const reminderPaused = (account.dunning_pause === true || pauseUntilActive)
    ? { active: true, until: pauseUntilActive ? account.dunning_pause_until ?? null : null }
    : null

  return (
    <div className="space-y-6">
      {/* Payment reminder (dunning) settings — per-client cadence + pause */}
      <div className="rounded-lg border bg-muted/30 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Bell className="h-4 w-4 text-amber-600" />
          <h3 className="text-sm font-semibold">Payment Reminder Settings</h3>
          {reminderPaused && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 font-medium">
              ⏸ Paused{reminderPaused.until ? ` until ${reminderPaused.until}` : ''}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Automatic reminders for overdue invoices. The 1st goes out this many days after the due date, the 2nd later; the system stops after 2. Set <strong>Reminders</strong> to Paused to stop all automatic chasing for this client, or set <strong>Paused until</strong> when the client promised to pay by a date — reminders stop until that day (inclusive) and resume by themselves after. Invoices still show as Overdue either way.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <EditableField
            label="1st reminder (days after due)"
            value={account.dunning_reminder_1_days != null ? String(account.dunning_reminder_1_days) : '7'}
            onSave={dunningSave('dunning_reminder_1_days')}
          />
          <EditableField
            label="2nd reminder (days after due)"
            value={account.dunning_reminder_2_days != null ? String(account.dunning_reminder_2_days) : '14'}
            onSave={dunningSave('dunning_reminder_2_days')}
          />
          <EditableField
            label="Reminders"
            type="select"
            options={[{ label: 'Active', value: 'false' }, { label: 'Paused', value: 'true' }]}
            value={account.dunning_pause ? 'true' : 'false'}
            onSave={dunningSave('dunning_pause')}
          />
          <EditableField
            label="Paused until (client promised to pay by)"
            type="date"
            value={account.dunning_pause_until ?? ''}
            onSave={dunningSave('dunning_pause_until')}
          />
          <div className="sm:col-span-2">
            <EditableField
              label="Pause reason (the trace — e.g. 'promised payment by end of Sept')"
              value={account.dunning_pause_reason ?? ''}
              onSave={dunningSave('dunning_pause_reason')}
            />
          </div>
        </div>
      </div>

      {overdue.length > 0 && (
        <PaymentSection title="Overdue" payments={overdue} color="text-red-600" today={today} reminderPaused={reminderPaused} />
      )}
      {pending.length > 0 && (
        <PaymentSection title="Pending" payments={pending} color="text-amber-600" today={today} reminderPaused={reminderPaused} />
      )}
      {paid.length > 0 && (
        <PaymentSection title="Paid" payments={paid} color="text-emerald-600" today={today} defaultCollapsed reminderPaused={reminderPaused} />
      )}
      {otherInvoiced.length > 0 && (
        <PaymentSection title="Other" payments={otherInvoiced} color="text-zinc-600" today={today} defaultCollapsed reminderPaused={reminderPaused} />
      )}
      {legacy.length > 0 && (
        <PaymentSection title="Legacy (pre-invoice)" payments={legacy} color="text-zinc-400" today={today} defaultCollapsed reminderPaused={reminderPaused} />
      )}
      {payments.length === 0 && (
        <p className="text-sm text-muted-foreground">No payments recorded</p>
      )}
    </div>
  )
}

function PaymentSection({
  title,
  payments,
  color,
  today,
  defaultCollapsed = false,
  reminderPaused = null,
}: {
  title: string
  payments: Payment[]
  color: string
  today: string
  defaultCollapsed?: boolean
  reminderPaused?: { active: boolean; until: string | null } | null
}) {
  const [open, setOpen] = useState(!defaultCollapsed)
  const total = payments.reduce((sum, p) => sum + (Number(p.total) || p.amount_due || p.amount || 0), 0)
  const curr = payments[0]?.amount_currency || 'USD'

  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 w-full text-left py-2">
        <span className={cn('font-semibold text-sm uppercase tracking-wide', color)}>{title}</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600">{payments.length}</span>
        <span className="text-xs text-muted-foreground ml-auto">
          {formatCurrency(total, curr)}
        </span>
      </button>
      {open && (
        <div className="bg-white rounded-lg border">
          <div className="hidden md:grid md:grid-cols-[120px,1fr,100px,100px,90px,100px,40px] gap-3 px-4 py-2 border-b bg-zinc-50 rounded-t-lg text-xs font-medium text-muted-foreground uppercase">
            <span>Invoice</span>
            <span>Description</span>
            <span className="text-right">Amount</span>
            <span>Date</span>
            <span>Status</span>
            <span>Method</span>
            <span></span>
          </div>
          {payments.map(p => {
            const status = p.invoice_status ?? p.status ?? '—'
            const isOverdue = p.due_date && p.due_date < today && status !== 'Paid' && status !== 'Cancelled' && status !== 'Waived'
            return (
              <div key={p.id} className={cn(
                'grid grid-cols-1 md:grid-cols-[120px,1fr,100px,100px,90px,100px,40px] gap-1 md:gap-3 px-4 py-2.5 border-b last:border-b-0 text-sm items-center',
                isOverdue && 'bg-red-50/50'
              )}>
                <span className="font-mono text-xs text-blue-600">{p.invoice_number ?? '—'}</span>
                <div className="min-w-0">
                  <p className="font-medium truncate">{p.description ?? '—'}</p>
                  {p.installment && <p className="text-xs text-muted-foreground">{p.installment}</p>}
                </div>
                <p className="text-right font-medium hidden md:block">{formatCurrency(Number(p.total) || p.amount, p.amount_currency)}</p>
                <p className="hidden md:block text-xs text-muted-foreground">{p.paid_date ? formatDate(p.paid_date) : p.due_date ? formatDate(p.due_date) : '—'}</p>
                <div className="hidden md:block">
                  <span className={cn('text-xs px-1.5 py-0.5 rounded', PAYMENT_STATUS_COLORS[status] ?? 'bg-zinc-100')}>
                    {status}
                  </span>
                  <InvoiceNoteDot note={p.notes} className="ml-1" />
                </div>
                <p className="hidden md:block text-xs text-muted-foreground truncate">{p.payment_method ?? '—'}</p>
                <div className="hidden md:flex justify-end">
                  <PaymentRowActions reminderPaused={reminderPaused} payment={{
                    id: p.id,
                    invoice_number: p.invoice_number ?? null,
                    description: p.description ?? null,
                    amount: p.amount ?? null,
                    total: p.total ?? null,
                    amount_currency: p.amount_currency ?? null,
                    status: p.status ?? null,
                    invoice_status: p.invoice_status ?? null,
                    due_date: p.due_date ?? null,
                    notes: p.notes ?? null,
                    message: (p as unknown as { message?: string | null }).message ?? null,
                  }} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ── Tax Tab ───────────────────────────────────── */

function TaxTab({ taxReturns, today }: { taxReturns: TaxReturn[]; today: string }) {
  if (taxReturns.length === 0) {
    return <p className="text-sm text-muted-foreground">No tax returns</p>
  }

  return (
    <div className="space-y-2">
      {taxReturns.map(tr => {
        // When an extension is on file, the effective deadline is the resolved
        // extension deadline (falls back to Oct 15 / Sept 15 rules when the
        // extension_deadline column is null). Without this, rows like "2025
        // SMLLC, original deadline Apr 15" render "5d overdue" even though
        // the extension pushes the real deadline to Oct 15.
        const extDeadline = tr.extension_filed
          ? resolveExtensionDeadline(tr.extension_deadline, tr.tax_year, tr.return_type as TaxReturnType)
          : null
        const effectiveDeadline = extDeadline ?? tr.deadline
        const due = parseISO(effectiveDeadline)
        const now = parseISO(today)
        const diff = differenceInDays(due, now)
        const isUrgent = diff <= 7 && tr.status !== 'TR Filed'

        return (
          <div key={tr.id} className={cn(
            'bg-white rounded-lg border p-4 text-sm',
            isUrgent && 'border-red-200 bg-red-50/50'
          )}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">{tr.tax_year}</span>
                <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
                  {tr.return_type}
                </span>
                {tr.paid && (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs px-2 py-0.5 rounded bg-zinc-100 text-zinc-600">
                  {tr.status}
                </span>
                <TaxRowActions taxReturn={tr} />
              </div>
            </div>
            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                Deadline: {formatDate(effectiveDeadline)}
                {tr.status !== 'TR Filed' && diff <= 30 && (
                  <span className={cn(
                    'ml-1 font-medium',
                    diff < 0 ? 'text-red-600' : diff <= 7 ? 'text-red-500' : 'text-amber-600'
                  )}>
                    ({diff < 0 ? `${Math.abs(diff)}d overdue` : diff === 0 ? 'today' : `${diff}d`})
                  </span>
                )}
              </span>
              {tr.extension_filed && extDeadline && (
                <span className="text-emerald-700">Extension filed — ext deadline: {formatDate(extDeadline)}</span>
              )}
              {tr.extension_filed && !extDeadline && tr.extension_deadline && (
                <span className="text-emerald-700">Extension filed — ext deadline: {formatDate(tr.extension_deadline)}</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* Documents Tab replaced by FileManager component (components/accounts/file-manager.tsx) */
