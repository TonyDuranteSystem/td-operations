'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Building2, User, Mail, Phone, Globe, MapPin,
  Calendar, Shield, FileText, CreditCard, Briefcase, Clock,
  AlertCircle, CheckCircle2, ExternalLink, MessageSquare, X, Eye, EyeOff, Loader2,
} from 'lucide-react'
import { AccountCommunications } from './account-communications'
import { EditableField } from './editable-field'
import { PortalUserButton } from './portal-user-button'
import { DocumentsPanel } from '@/app/(dashboard)/accounts/[id]/components/documents-panel'
import { GenerateOADialog } from '@/app/(dashboard)/accounts/[id]/components/generate-oa-dialog'
import { GenerateLeaseDialog } from '@/app/(dashboard)/accounts/[id]/components/generate-lease-dialog'
import { GenerateSS4Dialog } from '@/app/(dashboard)/accounts/[id]/components/generate-ss4-dialog'
import { PlaceClientWizard } from '@/app/(dashboard)/accounts/[id]/components/place-client-wizard'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { updateAccountField, updateContactField, addAccountNote, toggleDocumentPortalVisibility } from '@/app/(dashboard)/accounts/actions'
import { differenceInDays, parseISO, format } from 'date-fns'
import type { Account, Contact, Service, Payment, Deal, TaxReturn } from '@/lib/types'

const TABS = [
  { key: 'panoramica', label: 'Overview', icon: Building2, adminOnly: false },
  { key: 'servizi', label: 'Services', icon: Briefcase, adminOnly: false },
  { key: 'pagamenti', label: 'Payments', icon: CreditCard, adminOnly: true },
  { key: 'tax', label: 'Tax Returns', icon: FileText, adminOnly: false },
  { key: 'documenti', label: 'Documents', icon: FileText, adminOnly: false },
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
    return format(parseISO(d), 'dd/MM/yyyy')
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
}

export function AccountDetail({ account, contacts, services, payments, deals, taxReturns, documents = [], today, isAdmin = false }: AccountDetailProps) {
  const [activeTab, setActiveTab] = useState('panoramica')
  const [showOADialog, setShowOADialog] = useState(false)
  const [showLeaseDialog, setShowLeaseDialog] = useState(false)
  const [showSS4Dialog, setShowSS4Dialog] = useState(false)
  const [showPlaceClient, setShowPlaceClient] = useState(false)

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
            <h1 className="text-2xl font-semibold tracking-tight">{account.company_name}</h1>
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
            {isAdmin && (
              <PortalUserButton accountId={account.id} portalAccount={account.portal_account ?? false} />
            )}
            {isAdmin && (
              <button
                onClick={() => setShowPlaceClient(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-indigo-100 text-indigo-700 hover:bg-indigo-200 transition-colors"
              >
                <Building2 className="h-3.5 w-3.5" />
                Place Client
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

      {/* Documents to Sign Panel (admin only) */}
      {isAdmin && (
        <DocumentsPanel
          accountId={account.id}
          isAdmin={isAdmin}
          onGenerateOA={() => setShowOADialog(true)}
          onGenerateLease={() => setShowLeaseDialog(true)}
          onGenerateSS4={() => setShowSS4Dialog(true)}
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
        <PanoramicaTab account={account} contacts={contacts} deals={deals} isAdmin={isAdmin} />
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
        <DocumentsTab documents={documents} isAdmin={isAdmin} />
      )}
      {activeTab === 'comunicazioni' && (
        <AccountCommunications accountId={account.id} />
      )}
    </div>
  )
}

/* ── Panoramica Tab ───────────────────────────────────── */

function PanoramicaTab({ account, contacts, deals, isAdmin }: { account: Account; contacts: Contact[]; deals: Deal[]; isAdmin: boolean }) {
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
          <EditableField icon={Briefcase} label="Account Type" value={account.account_type ?? ''} type="select" options={ACCOUNT_TYPE_OPTIONS} readOnly={!isAdmin} onSave={makeAccountSaver('account_type')} />
          <EditableField icon={Building2} label="Entity Type" value={account.entity_type ?? ''} type="select" options={ENTITY_OPTIONS} readOnly={!isAdmin} onSave={makeAccountSaver('entity_type')} />
          <EditableField icon={MapPin} label="State" value={account.state_of_formation ?? ''} readOnly={!isAdmin} onSave={makeAccountSaver('state_of_formation')} />
          <EditableField icon={Calendar} label="Formation" value={account.formation_date ?? ''} type="date" readOnly={!isAdmin} onSave={makeAccountSaver('formation_date')} />
          <EditableField icon={Shield} label="EIN" value={account.ein_number ?? ''} readOnly={!isAdmin} onSave={makeAccountSaver('ein_number')} />
          <EditableField icon={FileText} label="Filing ID" value={account.filing_id ?? ''} readOnly={!isAdmin} onSave={makeAccountSaver('filing_id')} />
          <EditableField icon={Shield} label="Registered Agent" value={account.registered_agent ?? ''} readOnly={!isAdmin} onSave={makeAccountSaver('registered_agent')} />
          <EditableField icon={Calendar} label="RA Renewal" value={account.ra_renewal_date ?? ''} type="date" readOnly={!isAdmin} onSave={makeAccountSaver('ra_renewal_date')} />
          <EditableField icon={MapPin} label="Address" value={account.physical_address ?? ''} type="textarea" readOnly={!isAdmin} onSave={makeAccountSaver('physical_address')} />
          {account.gdrive_folder_url && (
            <div className="flex items-center gap-2">
              <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
              <a href={account.gdrive_folder_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline text-sm">
                Google Drive Folder
              </a>
            </div>
          )}
        </div>
      </div>

      {/* Billing */}
      <div className="bg-white rounded-lg border p-5 space-y-4">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Annual Installments</h3>
        <div className="grid gap-3 text-sm">
          <EditableField icon={CreditCard} label="1st Installment" value={account.installment_1_amount?.toString() ?? ''} readOnly={!isAdmin} onSave={makeAccountSaver('installment_1_amount')} />
          <EditableField icon={Globe} label="1st Currency" value={account.installment_1_currency ?? ''} type="select" options={[{ label: 'USD', value: 'USD' }, { label: 'EUR', value: 'EUR' }]} readOnly={!isAdmin} onSave={makeAccountSaver('installment_1_currency')} />
          <EditableField icon={CreditCard} label="2nd Installment" value={account.installment_2_amount?.toString() ?? ''} readOnly={!isAdmin} onSave={makeAccountSaver('installment_2_amount')} />
          <EditableField icon={Globe} label="2nd Currency" value={account.installment_2_currency ?? ''} type="select" options={[{ label: 'USD', value: 'USD' }, { label: 'EUR', value: 'EUR' }]} readOnly={!isAdmin} onSave={makeAccountSaver('installment_2_currency')} />
        </div>
      </div>

      {/* Contacts */}
      <div className="bg-white rounded-lg border p-5 space-y-4">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
          Contacts ({contacts.length})
        </h3>
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
                </div>
                <div className="pl-9 grid gap-1.5">
                  <EditableField icon={Mail} label="Email" value={c.email ?? ''} readOnly={!isAdmin} onSave={makeContactSaver(c.id, 'email', c.updated_at)} />
                  <EditableField icon={Phone} label="Phone" value={c.phone ?? ''} readOnly={!isAdmin} onSave={makeContactSaver(c.id, 'phone', c.updated_at)} />
                  <EditableField icon={Globe} label="Language" type="select" options={[{ label: '', value: '' }, { label: 'English', value: 'English' }, { label: 'Italian', value: 'Italian' }]} value={c.language ?? ''} readOnly={!isAdmin} onSave={makeContactSaver(c.id, 'language', c.updated_at)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Notes */}
      <div className="bg-white rounded-lg border p-5 space-y-3 lg:col-span-2">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Notes</h3>
        {account.notes && (
          <p className="text-sm whitespace-pre-wrap bg-zinc-50 p-3 rounded-md">{account.notes}</p>
        )}
        {isAdmin && (
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
        )}
        {!account.notes && !isAdmin && (
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
          Attivi ({active.length})
        </h3>
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nessun servizio attivo</p>
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
            Completati ({completed.length})
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
  const overdue = payments.filter(p =>
    (p.status === 'Due' || p.status === 'Overdue' || p.status === 'Partially Paid') &&
    p.due_date && p.due_date < today
  )
  const upcoming = payments.filter(p =>
    (p.status === 'Due' || p.status === 'Partially Paid') &&
    p.due_date && p.due_date >= today
  )
  const paid = payments.filter(p => p.status === 'Paid')
  const other = payments.filter(p =>
    !overdue.includes(p) && !upcoming.includes(p) && !paid.includes(p)
  )

  return (
    <div className="space-y-6">
      {overdue.length > 0 && (
        <PaymentSection title="Scaduti" payments={overdue} color="text-red-600" today={today} />
      )}
      {upcoming.length > 0 && (
        <PaymentSection title="In Arrivo" payments={upcoming} color="text-amber-600" today={today} />
      )}
      {paid.length > 0 && (
        <PaymentSection title="Pagati" payments={paid} color="text-emerald-600" today={today} defaultCollapsed />
      )}
      {other.length > 0 && (
        <PaymentSection title="Altro" payments={other} color="text-zinc-600" today={today} defaultCollapsed />
      )}
      {payments.length === 0 && (
        <p className="text-sm text-muted-foreground">Nessun pagamento registrato</p>
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
  const total = payments.reduce((sum, p) => sum + (p.amount_due ?? p.amount), 0)

  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 w-full text-left py-2">
        <span className={cn('font-semibold text-sm uppercase tracking-wide', color)}>{title}</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600">{payments.length}</span>
        <span className="text-xs text-muted-foreground ml-auto">
          {formatCurrency(total)}
        </span>
      </button>
      {open && (
        <div className="bg-white rounded-lg border overflow-hidden">
          <div className="hidden md:grid md:grid-cols-[1fr,100px,100px,100px,100px,100px] gap-3 px-4 py-2 border-b bg-zinc-50 text-xs font-medium text-muted-foreground uppercase">
            <span>Descrizione</span>
            <span className="text-right">Importo</span>
            <span className="text-right">Amount</span>
            <span>Due Date</span>
            <span>Status</span>
            <span>Follow-up</span>
          </div>
          {payments.map(p => {
            const isOverdue = p.due_date && p.due_date < today && p.status !== 'Paid' && p.status !== 'Cancelled' && p.status !== 'Waived'
            return (
              <div key={p.id} className={cn(
                'grid grid-cols-1 md:grid-cols-[1fr,100px,100px,100px,100px,100px] gap-1 md:gap-3 px-4 py-2.5 border-b last:border-b-0 text-sm items-center',
                isOverdue && 'bg-red-50/50'
              )}>
                <div className="min-w-0">
                  <p className="font-medium truncate">{p.description ?? (`${p.period ?? ''} ${p.year ?? ''}`.trim() || '—')}</p>
                  {p.installment && <p className="text-xs text-muted-foreground">{p.installment}</p>}
                </div>
                <p className="text-right font-medium hidden md:block">{formatCurrency(p.amount, p.amount_currency)}</p>
                <p className="text-right hidden md:block">{formatCurrency(p.amount_due, p.amount_currency)}</p>
                <p className="hidden md:block text-muted-foreground">{formatDate(p.due_date)}</p>
                <div className="hidden md:block">
                  <span className={cn('text-xs px-1.5 py-0.5 rounded', PAYMENT_STATUS_COLORS[p.status ?? ''] ?? 'bg-zinc-100')}>
                    {p.status}
                  </span>
                </div>
                <p className="hidden md:block text-xs text-muted-foreground">{p.followup_stage ?? '—'}</p>
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
    return <p className="text-sm text-muted-foreground">Nessuna dichiarazione fiscale</p>
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

/* ── Documents Tab ───────────────────────────────────── */

const CATEGORY_COLORS: Record<string, string> = {
  Company: 'bg-blue-100 text-blue-700',
  Contacts: 'bg-purple-100 text-purple-700',
  Tax: 'bg-amber-100 text-amber-700',
  Banking: 'bg-green-100 text-green-700',
  Correspondence: 'bg-zinc-100 text-zinc-700',
}

function formatFileSize(bytes: number | null): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function DocumentsTab({ documents, isAdmin }: { documents: DocumentRecord[]; isAdmin?: boolean }) {
  const [previewDoc, setPreviewDoc] = useState<DocumentRecord | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [visibilityMap, setVisibilityMap] = useState<Record<string, boolean>>(
    () => Object.fromEntries(documents.map(d => [d.id, d.portal_visible]))
  )

  const handleToggleVisibility = async (docId: string, currentVisible: boolean) => {
    setTogglingId(docId)
    const result = await toggleDocumentPortalVisibility(docId, !currentVisible)
    if (result.success) {
      setVisibilityMap(prev => ({ ...prev, [docId]: !currentVisible }))
      toast.success(`Portal visibility ${!currentVisible ? 'enabled' : 'disabled'}`)
    } else {
      toast.error(result.error ?? 'Failed')
    }
    setTogglingId(null)
  }

  // Group by category
  const grouped = documents.reduce<Record<string, DocumentRecord[]>>((acc, doc) => {
    const cat = doc.category_name || 'Uncategorized'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(doc)
    return acc
  }, {})

  const categoryOrder = ['Company', 'Contacts', 'Tax', 'Banking', 'Correspondence', 'Uncategorized']
  const sortedCategories = categoryOrder.filter(c => grouped[c])

  if (documents.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>No documents processed for this account</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{documents.length} documents</p>

      {sortedCategories.map(category => (
        <div key={category} className="space-y-2">
          <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
            {category} ({grouped[category].length})
          </h3>
          <div className="border rounded-lg divide-y">
            {grouped[category].map(doc => {
              const isVisible = visibilityMap[doc.id] ?? false
              return (
                <div
                  key={doc.id}
                  className="flex items-center justify-between px-4 py-2.5 hover:bg-zinc-50 transition-colors"
                >
                  <button
                    onClick={() => doc.drive_file_id ? setPreviewDoc(doc) : undefined}
                    className={cn(
                      'flex items-center gap-3 min-w-0 flex-1 text-left',
                      !doc.drive_file_id && 'opacity-60'
                    )}
                  >
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <span className="text-sm font-medium truncate block">{doc.file_name}</span>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {doc.document_type_name && <span>{doc.document_type_name}</span>}
                        {doc.file_size && <span>{formatFileSize(doc.file_size)}</span>}
                        {doc.processed_at && <span>{formatDate(doc.processed_at.split('T')[0])}</span>}
                      </div>
                    </div>
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    {doc.category_name && (
                      <span className={cn(
                        'text-xs px-2 py-0.5 rounded-full font-medium',
                        CATEGORY_COLORS[doc.category_name] || 'bg-zinc-100 text-zinc-600'
                      )}>
                        {doc.category_name}
                      </span>
                    )}
                    {isAdmin && (
                      <button
                        onClick={() => handleToggleVisibility(doc.id, isVisible)}
                        disabled={togglingId === doc.id}
                        title={isVisible ? 'Visible to client — click to hide' : 'Hidden from client — click to show'}
                        className={cn(
                          'p-1 rounded transition-colors',
                          isVisible
                            ? 'text-blue-600 hover:bg-blue-50'
                            : 'text-zinc-300 hover:bg-zinc-100 hover:text-zinc-500'
                        )}
                      >
                        {togglingId === doc.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : isVisible ? (
                          <Eye className="h-4 w-4" />
                        ) : (
                          <EyeOff className="h-4 w-4" />
                        )}
                      </button>
                    )}
                    {!isAdmin && doc.drive_file_id && (
                      <Eye className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {/* Full-screen document preview modal */}
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
              className="w-full h-full rounded-lg border-0"
            />
          </div>
        </div>
      )}
    </div>
  )
}
