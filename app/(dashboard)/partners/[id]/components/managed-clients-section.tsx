'use client'

import { useState } from 'react'
import Link from 'next/link'
import { UserPlus, FileText, X as XIcon, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { callPartnerAction, type PartnerData, type ManagedAccount } from './partner-actions'
import { AddClientDialog } from './add-client-dialog'
import { CreateInvoiceDialog } from './create-invoice-dialog'

interface ServiceInfo {
  account_id: string
  service_type: string
  stage: string
}

const STATUS_COLORS: Record<string, string> = {
  Active: 'bg-emerald-100 text-emerald-700',
  Inactive: 'bg-zinc-100 text-zinc-600',
  Closed: 'bg-red-100 text-red-700',
  Suspended: 'bg-amber-100 text-amber-700',
}

interface Props {
  partner: PartnerData
  accounts: ManagedAccount[]
  servicesByAccount: Record<string, ServiceInfo[]>
}

export function ManagedClientsSection({ partner, accounts, servicesByAccount }: Props) {
  const router = useRouter()
  const [showAddClient, setShowAddClient] = useState(false)
  const [showInvoice, setShowInvoice] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  const handleRemove = async (accountId: string, companyName: string) => {
    if (!confirm(`Remove ${companyName} from ${partner.partner_name}?`)) return
    setRemoving(accountId)
    const data = await callPartnerAction({ action: 'remove_client', account_id: accountId })
    setRemoving(null)
    if (data.success) {
      toast.success(`${companyName} removed`)
      router.refresh()
    } else {
      toast.error(data.detail ?? 'Failed to remove client')
    }
  }

  return (
    <>
      <div className="bg-white rounded-lg border overflow-hidden">
        <div className="px-5 py-3 border-b bg-zinc-50 flex items-center justify-between">
          <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
            Managed Clients ({accounts.length})
          </h3>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowAddClient(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border rounded-md hover:bg-white bg-white">
              <UserPlus className="h-3.5 w-3.5" /> Add Client
            </button>
            <button onClick={() => setShowInvoice(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border rounded-md hover:bg-white bg-white">
              <FileText className="h-3.5 w-3.5" /> Create Invoice
            </button>
          </div>
        </div>
        <div className="hidden md:grid md:grid-cols-[1fr,120px,120px,100px,1fr,60px] gap-3 px-4 py-2 border-b text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <span>Company</span>
          <span>Type</span>
          <span>State</span>
          <span>Status</span>
          <span>Active Services</span>
          <span></span>
        </div>
        {accounts.map(a => {
          const acctServices = servicesByAccount[a.id] ?? []
          return (
            <div key={a.id} className="grid grid-cols-1 md:grid-cols-[1fr,120px,120px,100px,1fr,60px] gap-1 md:gap-3 px-4 py-3 border-b last:border-b-0 hover:bg-zinc-50 transition-colors items-center">
              <Link href={`/accounts/${a.id}`} className="hover:underline">
                <div className="font-medium text-sm">{a.company_name}</div>
              </Link>
              <div className="text-xs text-muted-foreground">{a.entity_type ?? '—'}</div>
              <div className="text-xs text-muted-foreground">{a.state_of_formation ?? '—'}</div>
              <span className={`text-xs font-medium px-1.5 py-0.5 rounded w-fit ${STATUS_COLORS[a.status ?? ''] ?? 'bg-zinc-100 text-zinc-600'}`}>
                {a.status ?? '—'}
              </span>
              <div className="flex flex-wrap gap-1">
                {acctServices.map((s, i) => (
                  <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">
                    {s.service_type}: {s.stage}
                  </span>
                ))}
                {acctServices.length === 0 && <span className="text-xs text-zinc-400">No active services</span>}
              </div>
              <button
                onClick={() => handleRemove(a.id, a.company_name)}
                disabled={removing === a.id}
                className="text-zinc-400 hover:text-red-500 p-1 rounded hover:bg-red-50 transition-colors disabled:opacity-50"
                title="Remove from partner"
              >
                {removing === a.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <XIcon className="h-4 w-4" />}
              </button>
            </div>
          )
        })}
        {accounts.length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">No managed clients yet</div>
        )}
      </div>

      <AddClientDialog open={showAddClient} onClose={() => { setShowAddClient(false); router.refresh() }} partnerId={partner.id} existingAccountIds={accounts.map(a => a.id)} />
      <CreateInvoiceDialog open={showInvoice} onClose={() => { setShowInvoice(false); router.refresh() }} partner={partner} accounts={accounts} />
    </>
  )
}
