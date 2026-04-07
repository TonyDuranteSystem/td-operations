'use client'

import { useState } from 'react'
import { Send, Pencil, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { SendPortalDialog } from './send-portal-dialog'
import { EditPartnerDialog } from './edit-partner-dialog'

export interface PartnerData {
  id: string
  partner_name: string
  partner_email: string | null
  status: string
  commission_model: string | null
  agreed_services: string[] | null
  price_list: Record<string, number> | null
  notes: string | null
  contact: {
    id: string
    full_name: string
    email: string | null
    phone: string | null
    language: string | null
  } | null
}

export interface ManagedAccount {
  id: string
  company_name: string
  status: string | null
  entity_type: string | null
  state_of_formation: string | null
}

export async function callPartnerAction(body: Record<string, unknown>) {
  const res = await fetch('/api/crm/admin-actions/partner-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

export function PartnerHeaderActions({ partner }: { partner: PartnerData }) {
  const router = useRouter()
  const [showSendPortal, setShowSendPortal] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  const [updating, setUpdating] = useState(false)

  const handleStatusChange = async (newStatus: string) => {
    setUpdating(true)
    setStatusOpen(false)
    const data = await callPartnerAction({ action: 'update_status', partner_id: partner.id, status: newStatus })
    setUpdating(false)
    if (data.success) {
      toast.success(`Status changed to ${newStatus}`)
      router.refresh()
    } else {
      toast.error(data.detail ?? 'Failed to update status')
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <button onClick={() => setShowSendPortal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-md hover:bg-zinc-50">
          <Send className="h-3.5 w-3.5" /> Send Portal
        </button>
        <button onClick={() => setShowEdit(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-md hover:bg-zinc-50">
          <Pencil className="h-3.5 w-3.5" /> Edit
        </button>
        <div className="relative">
          <button onClick={() => setStatusOpen(!statusOpen)} disabled={updating}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-md hover:bg-zinc-50 disabled:opacity-50">
            Status <ChevronDown className="h-3 w-3" />
          </button>
          {statusOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setStatusOpen(false)} />
              <div className="absolute right-0 mt-1 w-36 bg-white border rounded-md shadow-lg z-20">
                {['active', 'suspended', 'inactive'].map(s => (
                  <button key={s} onClick={() => handleStatusChange(s)}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-zinc-50 capitalize ${s === partner.status ? 'font-bold bg-zinc-50' : ''}`}>
                    {s}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <SendPortalDialog open={showSendPortal} onClose={() => setShowSendPortal(false)} partner={partner} />
      <EditPartnerDialog open={showEdit} onClose={() => { setShowEdit(false); router.refresh() }} partner={partner} />
    </>
  )
}
