'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Building2, User, Users, Mail, Phone, Globe, MapPin,
  Calendar, Shield, FileText, CreditCard, Briefcase, Clock,
  AlertCircle, CheckCircle2, ExternalLink, MessageSquare, Inbox, Unlink,
  Plus, Search, Loader2, Stethoscope,
} from 'lucide-react'
import { AccountCommunications } from './account-communications'
import { EditableField } from './editable-field'
import { PortalUserButton } from './portal-user-button'
import { DocumentsPanel } from '@/app/(dashboard)/accounts/[id]/components/documents-panel'
import { GenerateOADialog } from '@/app/(dashboard)/accounts/[id]/components/generate-oa-dialog'
import { GenerateLeaseDialog } from '@/app/(dashboard)/accounts/[id]/components/generate-lease-dialog'
import { GenerateSS4Dialog } from '@/app/(dashboard)/accounts/[id]/components/generate-ss4-dialog'
import { PlaceClientWizard } from '@/app/(dashboard)/accounts/[id]/components/place-client-wizard'
import { ClientDiagnosticDialog } from '@/app/(dashboard)/accounts/[id]/components/client-diagnostic-dialog'
import { FileManager } from './file-manager'
import { CorrespondenceUpload } from './correspondence-upload'
import { AccountOfferPanel } from '@/components/offers/account-offer-panel'
import { AccountJourney } from './account-journey'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { updateAccountField, updateContactField, addAccountNote } from '@/app/(dashboard)/accounts/actions'
import { differenceInDays, parseISO, format } from 'date-fns'
import type { Account, Contact, Service, Payment, Deal, TaxReturn } from '@/lib/types'

const TABS = [
  { key: 'panoramica', label: 'Overview', icon: Building2, adminOnly: false },
  { key: 'servizi', label: 'Services', icon: Briefcase, adminOnly: false },
  { key: 'pagamenti', label: 'Payments', icon: CreditCard, adminOnly: true },
  { key: 'tax', label: 'Tax Returns', icon: FileText, adminOnly: false },
  { key: 'documenti', label: 'Documents', icon: FileText, adminOnly: false },
  { key: 'corrispondenza', label: 'Correspondence', icon: Inbox, adminOnly: false },
  { key: 'comunicazioni', label: 'Communications', icon: MessageSquare, adminOnly: false },
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
  const c = currency === 'EUR' ? '€' : '$'
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

interface OfferData {
  token: string
  status: string
  contract_type: string | null
  cost_summary: Array<{ label: string; total?: string; items?: Array<{ name: string; price: string }> }> | null
  view_count: number
  viewed_at: string | null
  created_at: string
  required_documents: Array<{ id: string; name: string }> | null
}

interface AccountDetailProps {
  account: Account
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
        toast.success(`${searchQuery.trim()} created and linked as ${selectedRole}`)
        setShowSearch(false)
        setShowCreateForm(false)
        setSearchQuery('')
        setNewEmail('')
        setSearchResults([])
        window.location.reload()
      } else {
        toast.error(result.error ?? 'Failed to create contact')
      }
    } catch {
      toast.error('Failed to create contact')
    } finally {
      setCreating(false)
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
        <button
            onClick={() => setShowSearch(!showSearch)}
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            <Plus className="h-3.5 w-3.5" />
            Link Contact
          </button>
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
                {c.role && <span className="text-xs text-muted-foreground">({c.role})</span>}
                <button
                  onClick={async () => {
                    if (!confirm(`Remove ${c.full_name} from this company?`)) return
                    const { unlinkContactFromAccount } = await import('@/app/(dashboard)/accounts/actions')
                    const result = await unlinkContactFromAccount(account.id, c.id)
                    if (result.success) {
                      toast.success(`${c.full_name} unlinked`)
                      window.location.reload()
                    } else {
                      toast.error('Failed to unlink contact')
                    }
                  }}
                  className="ml-auto p-1 rounded hover:bg-red-50 text-zinc-300 hover:text-red-500 transition-colors"
                  title={`Remove ${c.full_name} from this company`}
                >
                  <Unlink className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="pl-9 grid gap-1.5">
                <EditableField icon={Mail} label="Email" value={c.email ?? ''} onSave={makeContactSaver(c.id, 'email', c.updated_at)} />
                <EditableField icon={Phone} label="Phone" value={c.phone ?? ''} onSave={makeContactSaver(c.id, 'phone', c.updated_at)} />
                <EditableField icon={Globe} label="Language" type="select" options={[{ label: '', value: '' }, { label: 'English', value: 'English' }, { label: 'Italian', value: 'Italian' }]} value={c.language ?? ''} onSave={makeContactSaver(c.id, 'language', c.updated_at)} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function AccountDetail({ account, contacts, services, payments, deals, taxReturns, documents = [], today, isAdmin = false, offer = null, partnerName = null, pendingActivation = null, wizardProgress = null, serviceDeliveriesRaw = [] }: AccountDetailProps) {
  const [activeTab, setActiveTab] = useState('panoramica')
  const [showOADialog, setShowOADialog] = useState(false)
  const [showLeaseDialog, setShowLeaseDialog] = useState(false)
  const [showSS4Dialog, setShowSS4Dialog] = useState(false)
  const [showPlaceClient, setShowPlaceClient] = useState(false)
  const [showDiagnostic, setShowDiagnostic] = useState(false)

  const primaryContact = contacts[0] || null

  const activeServices = services.filter(s => s.status !== 'Completed' && s.status !== 'Cancelled')
  const overduePayments = payments.filter(p =>
    (p.status === 'Due' || p.status === 'Overdue' || p.status === 'Partially Paid') &&
    p.due_date && p.due_date < today
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link
          href="/accounts"
          className="mt-1 p-1.5 rounded-lg hover:bg-zinc-100 transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
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
              account.status === 'Closed' ? 'bg-zinc-100 text-zinc-600' :
              'bg-red-100 text-red-700'
            )}>
              {account.status}
            </span>
            <PortalUserButton accountId={account.id} portalAccount={account.portal_account ?? false} />
            <button
              onClick={() => setShowDiagnostic(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-amber-100 text-amber-700 hover:bg-amber-200 transition-colors"
            >
              <Stethoscope className="h-3.5 w-3.5" />
              Diagnose
            </button>
            <button
              onClick={() => setShowPlaceClient(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-indigo-100 text-indigo-700 hover:bg-indigo-200 transition-colors"
            >
              <Building2 className="h-3.5 w-3.5" />
              Place Client
            </button>
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

      {/* Documents to Sign Panel */}
      <DocumentsPanel
        accountId={account.id}
        isAdmin={true}
        onGenerateOA={() => setShowOADialog(true)}
        onGenerateLease={() => setShowLeaseDialog(true)}
        onGenerateSS4={() => setShowSS4Dialog(true)}
      />

      {/* Offer Panel */}
      <AccountOfferPanel
        accountId={account.id}
        companyName={account.company_name}
        clientEmail={primaryContact?.email || ''}
        clientLanguage={primaryContact?.language}
        offer={offer}
        isAdmin={isAdmin}
      />

      {/* Account Journey Tracker */}
      <AccountJourney
        offer={offer ? { token: offer.token, status: offer.status, contract_type: offer.contract_type, created_at: offer.created_at, view_count: offer.view_count, viewed_at: offer.viewed_at, cost_summary: offer.cost_summary } : null}
        pendingActivation={pendingActivation}
        wizardProgress={wizardProgress}
        serviceDeliveries={serviceDeliveriesRaw}
        accountType={account.account_type ?? null}
        portalTier={(account as unknown as Record<string, unknown>).portal_tier as string ?? null}
      />

      {/* Generate Document Dialogs */}
      <GenerateOADialog
        open={showOADialog}
        onClose={() => setShowOADialog(false)}
        accountId={account.id}
        companyName={account.company_name}
        state={account.state_of_formation}
        entityType={account.entity_type}
        contactName={primaryContact?.full_name || ''}
        formationDate={account.formation_date}
        ein={account.ein_number}
      />
      <GenerateLeaseDialog
        open={showLeaseDialog}
        onClose={() => setShowLeaseDialog(false)}
        accountId={account.id}
        companyName={account.company_name}
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

      {/* Tabs */}
      <div className="border-b">
        <div className="flex gap-1 -mb-px overflow-x-auto">
          {TABS.filter(tab => !tab.adminOnly || isAdmin).map(tab => {
            const Icon = tab.icon
            const count = tab.key === 'servizi' ? services.length :
                         tab.key === 'pagamenti' ? payments.length :
                         tab.key === 'tax' ? taxReturns.length :
                         tab.key === 'documenti' ? documents.length : null
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
      {activeTab === 'panoramica' && (
        <PanoramicaTab account={account} contacts={contacts} deals={deals} payments={payments} isAdmin={isAdmin} partnerName={partnerName} />
      )}
      {activeTab === 'servizi' && (
        <ServiziTab services={services} today={today} />
      )}
      {activeTab === 'pagamenti' && (
        <PagamentiTab payments={payments} today={today} />
      )}
      {activeTab === 'tax' && (
        <TaxTab taxReturns={taxReturns} today={today} />
      )}
      {activeTab === 'documenti' && (
        <FileManager accountId={account.id} driveFolderId={account.drive_folder_id} isAdmin={true} />
      )}
      {activeTab === 'corrispondenza' && (
        <div className="p-4">
          <CorrespondenceUpload accountId={account.id} />
        </div>
      )}
      {activeTab === 'comunicazioni' && (
        <AccountCommunications accountId={account.id} />
      )}
    </div>
  )
}

/* ── Installments Section ────────────────────────────── */

function InstallmentsSection({ account, payments, makeAccountSaver }: { account: Account; payments: Payment[]; makeAccountSaver: (field: string) => (val: string) => Promise<{ success: boolean; error?: string }> }) {
  // Resolve 1st installment invoice first
  const inst1Amount = account.installment_1_amount
  const inst1Currency = account.installment_1_currency ?? 'USD'
  const inst1Match = inst1Amount ? findInstallmentInvoice(payments, inst1Amount, inst1Currency, []) : null

  // Resolve 2nd installment, excluding the 1st match to avoid double-counting
  const inst2Amount = account.installment_2_amount
  const inst2Currency = account.installment_2_currency ?? 'USD'
  const excludeIds = inst1Match ? [inst1Match.id] : []
  const inst2Match = inst2Amount ? findInstallmentInvoice(payments, inst2Amount, inst2Currency, excludeIds) : null

  return (
    <div className="bg-white rounded-lg border p-5 space-y-4">
      <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Annual Installments</h3>
      <div className="grid gap-3 text-sm">
        <EditableField icon={CreditCard} label="1st Installment" value={inst1Amount?.toString() ?? ''} onSave={makeAccountSaver('installment_1_amount')} />
        <EditableField icon={Globe} label="1st Currency" value={inst1Currency} type="select" options={[{ label: 'USD', value: 'USD' }, { label: 'EUR', value: 'EUR' }]} onSave={makeAccountSaver('installment_1_currency')} />
        {inst1Amount && <InstallmentBadge match={inst1Match} />}
        <EditableField icon={CreditCard} label="2nd Installment" value={inst2Amount?.toString() ?? ''} onSave={makeAccountSaver('installment_2_amount')} />
        <EditableField icon={Globe} label="2nd Currency" value={inst2Currency} type="select" options={[{ label: 'USD', value: 'USD' }, { label: 'EUR', value: 'EUR' }]} onSave={makeAccountSaver('installment_2_currency')} />
        {inst2Amount && <InstallmentBadge match={inst2Match} />}
      </div>
    </div>
  )
}

function findInstallmentInvoice(payments: Payment[], amount: number, currency: string, excludeIds: string[]): Payment | null {
  return payments.find(p => {
    if (excludeIds.includes(p.id)) return false
    const invTotal = Number(p.total) || p.amount || 0
    const invCurr = p.amount_currency || 'USD'
    return Math.abs(invTotal - amount) < 2 && invCurr === currency && p.invoice_number && p.invoice_number !== '1.0' && p.invoice_number !== '2.0'
  }) ?? null
}

function InstallmentBadge({ match }: { match: Payment | null }) {
  if (!match) {
    return (
      <div className="flex items-center gap-2 pl-6 text-xs">
        <span className="px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500">Not invoiced</span>
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

/* ── Panoramica Tab ───────────────────────────────────── */

function PanoramicaTab({ account, contacts, deals, payments, isAdmin, partnerName }: { account: Account; contacts: Contact[]; deals: Deal[]; payments: Payment[]; isAdmin: boolean; partnerName: string | null }) {
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

  const ACCOUNT_TYPE_OPTIONS = [
    { label: 'Client', value: 'Client' },
    { label: 'One-Time', value: 'One-Time' },
  ]

  const _STATUS_OPTIONS = [
    { label: 'Active', value: 'Active' },
    { label: 'Inactive', value: 'Inactive' },
    { label: 'Closed', value: 'Closed' },
    { label: 'Suspended', value: 'Suspended' },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Company Info */}
      <div className="bg-white rounded-lg border p-5 space-y-4">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Company Info</h3>
        <div className="grid gap-3 text-sm">
          <EditableField icon={Briefcase} label="Account Type" value={account.account_type ?? ''} type="select" options={ACCOUNT_TYPE_OPTIONS} onSave={makeAccountSaver('account_type')} />
          <EditableField icon={Building2} label="Entity Type" value={account.entity_type ?? ''} type="select" options={ENTITY_OPTIONS} onSave={makeAccountSaver('entity_type')} />
          <EditableField icon={MapPin} label="State" value={account.state_of_formation ?? ''} onSave={makeAccountSaver('state_of_formation')} />
          <EditableField icon={Calendar} label="Formation" value={account.formation_date ?? ''} type="date" onSave={makeAccountSaver('formation_date')} />
          <EditableField icon={Shield} label="EIN" value={account.ein_number ?? ''} onSave={makeAccountSaver('ein_number')} />
          <EditableField icon={FileText} label="Filing ID" value={account.filing_id ?? ''} onSave={makeAccountSaver('filing_id')} />
          <EditableField icon={Shield} label="Registered Agent" value={account.registered_agent ?? ''} onSave={makeAccountSaver('registered_agent')} />
          <EditableField icon={Calendar} label="RA Renewal" value={account.ra_renewal_date ?? ''} type="date" onSave={makeAccountSaver('ra_renewal_date')} />
          <EditableField icon={MapPin} label="Address" value={account.physical_address ?? ''} type="textarea" onSave={makeAccountSaver('physical_address')} />
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

      {/* Billing */}
      <InstallmentsSection account={account} payments={payments} makeAccountSaver={makeAccountSaver} />

      {/* Contacts */}
      <ContactsSection
        contacts={contacts}
        account={account}
        makeContactSaver={makeContactSaver}
      />

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

      {/* Deals — admin only (shows financial amounts) */}
      {isAdmin && deals.length > 0 && (
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

function ServiziTab({ services, today }: { services: Service[]; today: string }) {
  const active = services.filter(s => s.status !== 'Completed' && s.status !== 'Cancelled')
  const completed = services.filter(s => s.status === 'Completed' || s.status === 'Cancelled')

  return (
    <div className="space-y-6">
      {/* Active services */}
      <div className="space-y-2">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
          Active ({active.length})
        </h3>
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active services</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {active.map(s => (
              <ServiceCard key={s.id} service={s} today={today} />
            ))}
          </div>
        )}
      </div>

      {/* Completed */}
      {completed.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
            Completed ({completed.length})
          </h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {completed.map(s => (
              <ServiceCard key={s.id} service={s} today={today} />
            ))}
          </div>
        </div>
      )}
    </div>
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

function PagamentiTab({ payments, today }: { payments: Payment[]; today: string }) {
  // Split into invoiced (unified system) vs legacy tracking records
  const invoiced = payments.filter(p => p.invoice_number && p.invoice_number !== '1.0' && p.invoice_number !== '2.0')
  const legacy = payments.filter(p => !p.invoice_number || p.invoice_number === '1.0' || p.invoice_number === '2.0')

  // Group invoiced by status
  const invoiceStatus = (p: Payment) => p.invoice_status ?? p.status ?? ''
  const overdue = invoiced.filter(p => invoiceStatus(p) === 'Overdue' || (invoiceStatus(p) === 'Sent' && p.due_date && p.due_date < today))
  const pending = invoiced.filter(p => ['Sent', 'Draft', 'Partial'].includes(invoiceStatus(p)) && !(p.due_date && p.due_date < today))
  const paid = invoiced.filter(p => invoiceStatus(p) === 'Paid')
  const otherInvoiced = invoiced.filter(p => !overdue.includes(p) && !pending.includes(p) && !paid.includes(p))

  return (
    <div className="space-y-6">
      {overdue.length > 0 && (
        <PaymentSection title="Overdue" payments={overdue} color="text-red-600" today={today} />
      )}
      {pending.length > 0 && (
        <PaymentSection title="Pending" payments={pending} color="text-amber-600" today={today} />
      )}
      {paid.length > 0 && (
        <PaymentSection title="Paid" payments={paid} color="text-emerald-600" today={today} defaultCollapsed />
      )}
      {otherInvoiced.length > 0 && (
        <PaymentSection title="Other" payments={otherInvoiced} color="text-zinc-600" today={today} defaultCollapsed />
      )}
      {legacy.length > 0 && (
        <PaymentSection title="Legacy (pre-invoice)" payments={legacy} color="text-zinc-400" today={today} defaultCollapsed />
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
}: {
  title: string
  payments: Payment[]
  color: string
  today: string
  defaultCollapsed?: boolean
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
        <div className="bg-white rounded-lg border overflow-hidden">
          <div className="hidden md:grid md:grid-cols-[120px,1fr,100px,100px,90px,100px] gap-3 px-4 py-2 border-b bg-zinc-50 text-xs font-medium text-muted-foreground uppercase">
            <span>Invoice</span>
            <span>Description</span>
            <span className="text-right">Amount</span>
            <span>Date</span>
            <span>Status</span>
            <span>Method</span>
          </div>
          {payments.map(p => {
            const status = p.invoice_status ?? p.status ?? '—'
            const isOverdue = p.due_date && p.due_date < today && status !== 'Paid' && status !== 'Cancelled' && status !== 'Waived'
            return (
              <div key={p.id} className={cn(
                'grid grid-cols-1 md:grid-cols-[120px,1fr,100px,100px,90px,100px] gap-1 md:gap-3 px-4 py-2.5 border-b last:border-b-0 text-sm items-center',
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
                </div>
                <p className="hidden md:block text-xs text-muted-foreground truncate">{p.payment_method ?? '—'}</p>
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
        const due = parseISO(tr.deadline)
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
              <span className="text-xs px-2 py-0.5 rounded bg-zinc-100 text-zinc-600">
                {tr.status}
              </span>
            </div>
            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                Deadline: {formatDate(tr.deadline)}
                {tr.status !== 'TR Filed' && diff <= 30 && (
                  <span className={cn(
                    'ml-1 font-medium',
                    diff < 0 ? 'text-red-600' : diff <= 7 ? 'text-red-500' : 'text-amber-600'
                  )}>
                    ({diff < 0 ? `${Math.abs(diff)}d overdue` : diff === 0 ? 'today' : `${diff}d`})
                  </span>
                )}
              </span>
              {tr.extension_filed && tr.extension_deadline && (
                <span>Ext: {formatDate(tr.extension_deadline)}</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* Documents Tab replaced by FileManager component (components/accounts/file-manager.tsx) */
