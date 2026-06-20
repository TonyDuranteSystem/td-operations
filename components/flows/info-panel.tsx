import { Building2, Contact, Flag, Clock, CalendarClock, UserRound, CheckCircle2, CalendarCheck, Receipt, ExternalLink, MapPin, Hash, Landmark, Home } from 'lucide-react'
import type { WorkspaceServiceDelivery, WorkspaceAccount, WorkspaceInvoice } from './types'
import { daysSince, formatUploadDate } from '@/lib/flows/workspace-format'

interface InfoPanelProps {
  serviceDelivery: WorkspaceServiceDelivery
  account: WorkspaceAccount
  /** 2nd installment invoice — shown only on Tax Return "Awaiting 2nd Payment". */
  secondInstallment?: WorkspaceInvoice | null
}

/** Format an invoice amount + currency, e.g. "$849.00". Falls back to a plain
 *  "amount currency" string if the currency code isn't a valid ISO code. */
function formatMoney(amount: number | null, currency: string | null): string {
  if (amount == null) return '—'
  const code = currency ?? 'USD'
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(amount)
  } catch {
    return `${amount} ${code}`
  }
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      <span className="mt-0.5 text-zinc-400">{icon}</span>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-zinc-400">{label}</div>
        <div className="text-sm text-zinc-800">{value}</div>
      </div>
    </div>
  )
}

/**
 * Overview card for a flow Workspace: company, current stage, time-in-stage,
 * deadline (if any) and assignee. Pure display — no interactivity.
 */
export function InfoPanel({ serviceDelivery: sd, account, secondInstallment }: InfoPanelProps) {
  const days = daysSince(sd.stage_entered_at)
  const stageLabel = sd.stage ?? '—'
  const clientLabel = sd.current_client_label

  // On the terminal stage, show a completed summary: when it was finished and
  // (for recurring renewal flows) the next renewal date pulled from the account.
  // AR / RA close at "Closed"; Tax Return closes at "Completed".
  const isClosed = sd.stage === 'Closed' || sd.stage === 'Completed'
  const isRenewalFlow =
    sd.service_type === 'State RA Renewal' || sd.service_type === 'State Annual Report'
  const completedDate = formatUploadDate(sd.stage_entered_at)
  const nextRenewal =
    sd.service_type === 'State RA Renewal' ? account.ra_renewal_date : account.annual_report_due_date
  const nextRenewalLabel = formatUploadDate(nextRenewal)

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      {isClosed && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2">
          <CheckCircle2 className="h-4 w-4 text-green-600" />
          <span className="text-sm font-semibold text-green-700">Completed</span>
        </div>
      )}
      <h3 className="text-sm font-semibold text-zinc-900 mb-1">Overview</h3>
      <div className="divide-y divide-zinc-100">
        <Row icon={<Building2 className="h-4 w-4" />} label="Company" value={account.company_name ?? '—'} />
        {/* Contact-scoped SDs (in-flight Company Formation, ITIN) have no account/
            company yet — surface the client name so the workspace is identifiable. */}
        {sd.contact_name && (
          <Row icon={<Contact className="h-4 w-4" />} label="Contact" value={sd.contact_name} />
        )}
        {/* Company context — shown whenever the data exists. For Company Formation
            these populate once the company is materialized (EIN at "EIN Received",
            RA/mailing once set on the account); state resolves earlier from the
            formation wizard for in-flight (contact-scoped) formations. */}
        {account.state_of_formation && (
          <Row icon={<MapPin className="h-4 w-4" />} label="State of formation" value={account.state_of_formation} />
        )}
        {account.ein_number && (
          <Row icon={<Hash className="h-4 w-4" />} label="EIN" value={account.ein_number} />
        )}
        {account.registered_agent_address && (
          <Row icon={<Landmark className="h-4 w-4" />} label="Registered Agent" value={account.registered_agent_address} />
        )}
        {account.mailing_address && (
          <Row icon={<Home className="h-4 w-4" />} label="Mailing address" value={account.mailing_address} />
        )}
        <Row
          icon={<Flag className="h-4 w-4" />}
          label="Current stage"
          value={
            <span>
              {stageLabel}
              {clientLabel && clientLabel !== stageLabel && (
                <span className="text-zinc-400"> · “{clientLabel}”</span>
              )}
            </span>
          }
        />
        <Row
          icon={<Clock className="h-4 w-4" />}
          label="Time in stage"
          value={days === null ? '—' : days === 0 ? 'Today' : `${days} day${days === 1 ? '' : 's'}`}
        />
        <Row
          icon={<CalendarClock className="h-4 w-4" />}
          label="Deadline"
          value={sd.due_date ?? <span className="text-zinc-400">None</span>}
        />
        <Row
          icon={<UserRound className="h-4 w-4" />}
          label="Assignee"
          value={sd.assigned_to ?? <span className="text-zinc-400">Unassigned</span>}
        />
        {isClosed && (
          <Row
            icon={<CheckCircle2 className="h-4 w-4 text-green-600" />}
            label="Completed on"
            value={completedDate ?? <span className="text-zinc-400">—</span>}
          />
        )}
        {isClosed && isRenewalFlow && (
          <Row
            icon={<CalendarCheck className="h-4 w-4" />}
            label="Next renewal"
            value={nextRenewalLabel ?? <span className="text-zinc-400">Not set</span>}
          />
        )}
      </div>

      {/* 2nd installment invoice — Awaiting 2nd Payment stage only. */}
      {sd.stage === 'Awaiting 2nd Payment' && (
        <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
          <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-zinc-500">
            <Receipt className="h-3.5 w-3.5" />
            2nd Installment Invoice
          </div>
          {secondInstallment ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-zinc-900">
                  Invoice {secondInstallment.invoice_number ? `#${secondInstallment.invoice_number}` : '—'}
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                    secondInstallment.is_paid
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-amber-100 text-amber-700'
                  }`}
                >
                  {secondInstallment.is_paid
                    ? 'Paid'
                    : `Unpaid${secondInstallment.invoice_status ? ` · ${secondInstallment.invoice_status}` : ''}`}
                </span>
              </div>
              <div className="text-sm text-zinc-700">
                {formatMoney(secondInstallment.amount, secondInstallment.currency)}
                {secondInstallment.is_paid
                  ? secondInstallment.paid_date && (
                      <span className="text-zinc-400"> · paid {formatUploadDate(secondInstallment.paid_date)}</span>
                    )
                  : secondInstallment.due_date && (
                      <span className="text-zinc-400"> · due {secondInstallment.due_date}</span>
                    )}
              </div>
              <a
                href={`/api/invoices/${secondInstallment.id}/pdf`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View invoice
              </a>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">
              No 2nd installment invoice found for {new Date().getFullYear()} yet.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
