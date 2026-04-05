'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, User, Mail, Phone, Globe, MapPin,
  Calendar, Shield, FileText, Briefcase, Clock,
  Building2, MessageSquare, KeyRound, CheckCircle2,
  Loader2, ChevronRight, Eye, X, FolderOpen, CreditCard,
} from 'lucide-react'
import { EditableField } from '@/components/accounts/editable-field'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { updateContactField, addContactNote } from '@/app/(dashboard)/contacts/[id]/actions'
import { format, parseISO } from 'date-fns'
import type { LinkedAccount, ServiceDelivery, ConversationEntry } from '@/lib/types'

// ─── Constants ───

const TABS = [
  { key: 'overview', label: 'Overview', icon: User },
  { key: 'services', label: 'Services', icon: Briefcase },
  { key: 'invoices', label: 'Invoices', icon: CreditCard },
  { key: 'documents', label: 'Documents', icon: FolderOpen },
  { key: 'portal', label: 'Portal', icon: KeyRound },
  { key: 'activity', label: 'Activity', icon: MessageSquare },
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
}: ContactDetailProps) {
  const [activeTab, setActiveTab] = useState('overview')

  const makeContactSaver = (field: string) => async (value: string) => {
    const result = await updateContactField(contact.id, field, value, contact.updated_at)
    if (result.success) toast.success('Saved')
    else toast.error(result.error ?? 'Failed')
    return result
  }

  const activeSds = serviceDeliveries.filter(sd => sd.status === 'active')

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link href="/contacts" className="p-2 rounded-lg hover:bg-zinc-100 transition-colors">
            <ArrowLeft className="h-5 w-5" />
          </Link>
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
      </div>

      {/* Tabs */}
      <div className="border-b">
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map(tab => {
            const Icon = tab.icon
            let count = 0
            if (tab.key === 'services') count = activeSds.length
            if (tab.key === 'invoices') count = invoices.filter(i => i.invoice_number && i.invoice_number !== '1.0' && i.invoice_number !== '2.0').length
            if (tab.key === 'documents') count = documents.length
            if (tab.key === 'activity') count = conversations.length

            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
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
                  <span className="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-zinc-100 text-zinc-600 font-medium">
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
        />
      )}
      {activeTab === 'services' && (
        <ServicesTab serviceDeliveries={serviceDeliveries} accounts={accounts} />
      )}
      {activeTab === 'invoices' && (
        <InvoicesTab invoices={invoices} />
      )}
      {activeTab === 'documents' && (
        <ContactDocumentsTab documents={documents} accounts={accounts} />
      )}
      {activeTab === 'portal' && (
        <PortalTab contact={contact} portalAuth={portalAuth} />
      )}
      {activeTab === 'activity' && (
        <ActivityTab conversations={conversations} />
      )}
    </div>
  )
}

// ─── Overview Tab ───

function OverviewTab({
  contact,
  accounts,
  lead,
  makeContactSaver,
}: {
  contact: ContactRecord
  accounts: LinkedAccount[]
  lead: LeadOrigin | null
  makeContactSaver: (field: string) => (value: string) => Promise<{ success: boolean; error?: string }>
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
    </div>
  )
}

// ─── Services Tab ───

function ServicesTab({
  serviceDeliveries,
  accounts,
}: {
  serviceDeliveries: ServiceDelivery[]
  accounts: LinkedAccount[]
}) {
  const accountMap = new Map(accounts.map(a => [a.id, a.company_name]))

  if (serviceDeliveries.length === 0) {
    return (
      <div className="bg-white rounded-lg border p-8 text-center text-sm text-muted-foreground">
        No service deliveries found
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border overflow-hidden">
      <div className="hidden md:grid md:grid-cols-[1fr,120px,1fr,100px,80px,100px] gap-3 px-4 py-2.5 border-b bg-zinc-50 text-xs font-medium text-muted-foreground uppercase tracking-wider">
        <span>Service</span>
        <span>Type</span>
        <span>Stage</span>
        <span>Status</span>
        <span>Assigned</span>
        <span>Account</span>
      </div>
      {serviceDeliveries.map(sd => (
        <div
          key={sd.id}
          className="grid grid-cols-1 md:grid-cols-[1fr,120px,1fr,100px,80px,100px] gap-1 md:gap-3 px-4 py-3 border-b last:border-b-0 hover:bg-zinc-50 transition-colors items-center"
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
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function ContactDocumentsTab({
  documents,
  accounts,
}: {
  documents: ContactDocumentRecord[]
  accounts: LinkedAccount[]
}) {
  const [previewDoc, setPreviewDoc] = useState<ContactDocumentRecord | null>(null)
  const accountMap = new Map(accounts.map(a => [a.id, a.company_name]))

  // Group by category
  const grouped = documents.reduce<Record<string, ContactDocumentRecord[]>>((acc, doc) => {
    const cat = doc.category_name || 'Uncategorized'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(doc)
    return acc
  }, {})

  const categoryOrder = ['Contacts', 'Company', 'Tax', 'Banking', 'Correspondence', 'Uncategorized']
  const sortedCategories = categoryOrder.filter(c => grouped[c])

  if (documents.length === 0) {
    return (
      <div className="bg-white rounded-lg border p-8 text-center text-sm text-muted-foreground">
        <FolderOpen className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>No documents linked to this contact</p>
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
                  {doc.category_name && (
                    <span className={cn(
                      'text-xs px-2 py-0.5 rounded-full font-medium',
                      CATEGORY_COLORS[doc.category_name] || 'bg-zinc-100 text-zinc-600'
                    )}>
                      {doc.category_name}
                    </span>
                  )}
                  {doc.drive_file_id && (
                    <Eye className="h-4 w-4 text-muted-foreground" />
                  )}
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
