'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Building2, User, Mail, Phone, Globe, MapPin,
  Calendar, Shield, FileText, CreditCard, Briefcase, Clock,
  AlertCircle, CheckCircle2, ExternalLink,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { differenceInDays, parseISO, format } from 'date-fns'
import type { Account, Contact, Service, Payment, Deal, TaxReturn } from '@/lib/types'

const TABS = [
  { key: 'panoramica', label: 'Panoramica', icon: Building2 },
  { key: 'servizi', label: 'Servizi', icon: Briefcase },
  { key: 'pagamenti', label: 'Pagamenti', icon: CreditCard },
  { key: 'tax', label: 'Tax Returns', icon: FileText },
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

interface AccountDetailProps {
  account: Account
  contacts: Contact[]
  services: Service[]
  payments: Payment[]
  deals: Deal[]
  taxReturns: TaxReturn[]
  today: string
}

export function AccountDetail({ account, contacts, services, payments, deals, taxReturns, today }: AccountDetailProps) {
  const [activeTab, setActiveTab] = useState('panoramica')

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
          </div>
          <p className="text-muted-foreground text-sm mt-1">
            {account.state_of_formation && `${account.state_of_formation} · `}
            {activeServices.length} servizi attivi · {overduePayments.length} pagamenti scaduti
          </p>
        </div>
      </div>

      {/* Alert banner for overdue */}
      {overduePayments.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="font-medium">{overduePayments.length} pagament{overduePayments.length === 1 ? 'o' : 'i'} scadut{overduePayments.length === 1 ? 'o' : 'i'}</span>
          <span className="text-red-600">
            — totale: {formatCurrency(overduePayments.reduce((sum, p) => sum + (p.amount_due ?? p.amount), 0))}
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b">
        <div className="flex gap-1 -mb-px overflow-x-auto">
          {TABS.map(tab => {
            const Icon = tab.icon
            const count = tab.key === 'servizi' ? services.length :
                         tab.key === 'pagamenti' ? payments.length :
                         tab.key === 'tax' ? taxReturns.length : null
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
        <PanoramicaTab account={account} contacts={contacts} deals={deals} />
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
    </div>
  )
}

/* ── Panoramica Tab ───────────────────────────────────── */

function PanoramicaTab({ account, contacts, deals }: { account: Account; contacts: Contact[]; deals: Deal[] }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Company Info */}
      <div className="bg-white rounded-lg border p-5 space-y-4">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Informazioni Azienda</h3>
        <div className="grid gap-3 text-sm">
          <InfoRow icon={Building2} label="Entity Type" value={account.entity_type ?? '—'} />
          <InfoRow icon={MapPin} label="Stato" value={account.state_of_formation ?? '—'} />
          <InfoRow icon={Calendar} label="Formazione" value={formatDate(account.formation_date)} />
          <InfoRow icon={Shield} label="EIN" value={account.ein_number ?? '—'} />
          <InfoRow icon={FileText} label="Filing ID" value={account.filing_id ?? '—'} />
          <InfoRow icon={Shield} label="Registered Agent" value={account.registered_agent ?? '—'} />
          <InfoRow icon={Calendar} label="RA Renewal" value={formatDate(account.ra_renewal_date)} />
          {account.physical_address && (
            <InfoRow icon={MapPin} label="Indirizzo" value={account.physical_address} />
          )}
          {account.gdrive_folder_url && (
            <div className="flex items-center gap-2">
              <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
              <a
                href={account.gdrive_folder_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline text-sm"
              >
                Google Drive Folder
              </a>
            </div>
          )}
        </div>
      </div>

      {/* Contacts */}
      <div className="bg-white rounded-lg border p-5 space-y-4">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
          Contatti ({contacts.length})
        </h3>
        {contacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nessun contatto collegato</p>
        ) : (
          <div className="space-y-4">
            {contacts.map(c => (
              <div key={c.id} className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center shrink-0">
                  <User className="h-4 w-4 text-zinc-500" />
                </div>
                <div className="min-w-0 text-sm">
                  <p className="font-medium">{c.full_name}</p>
                  {c.role && <p className="text-xs text-muted-foreground">{c.role}</p>}
                  {c.email && (
                    <p className="flex items-center gap-1 text-muted-foreground">
                      <Mail className="h-3 w-3" /> {c.email}
                    </p>
                  )}
                  {c.phone && (
                    <p className="flex items-center gap-1 text-muted-foreground">
                      <Phone className="h-3 w-3" /> {c.phone}
                    </p>
                  )}
                  {c.language && (
                    <p className="flex items-center gap-1 text-muted-foreground">
                      <Globe className="h-3 w-3" /> {c.language}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Notes */}
      {account.notes && (
        <div className="bg-white rounded-lg border p-5 space-y-2 lg:col-span-2">
          <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Note</h3>
          <p className="text-sm whitespace-pre-wrap">{account.notes}</p>
        </div>
      )}

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
                    {d.stage} · {d.deal_category ?? d.deal_type ?? '—'}
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

function InfoRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
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
            {slaDays < 0 ? `Scaduto ${Math.abs(slaDays)}g` :
             slaDays === 0 ? 'Scade oggi' : `${slaDays}g`}
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
            <span className="text-right">Dovuto</span>
            <span>Scadenza</span>
            <span>Stato</span>
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
                    ({diff < 0 ? `scaduto ${Math.abs(diff)}g` : diff === 0 ? 'oggi' : `${diff}g`})
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
