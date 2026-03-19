'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { InvoiceForm } from '@/components/portal/invoice-form'
import Link from 'next/link'

export default function EditInvoicePage() {
  const params = useParams()
  const invoiceId = params.id as string

  const [loading, setLoading] = useState(true)
  const [invoice, setInvoice] = useState<{
    accountId: string
    customers: { id: string; name: string; email: string | null }[]
    initialData: {
      id: string
      customerId: string
      currency: 'USD' | 'EUR'
      discount: number
      issueDate: string
      dueDate: string
      notes: string
      message: string
      bankAccountId?: string | null
      items: { description: string; quantity: number; unit_price: number; amount: number }[]
    }
  } | null>(null)

  useEffect(() => {
    async function load() {
      // Fetch invoice
      const res = await fetch(`/api/portal/invoices/${invoiceId}`)
      if (!res.ok) { setLoading(false); return }
      const data = await res.json()

      // Only Draft invoices can be edited
      if (data.status !== 'Draft') { setLoading(false); return }

      // Fetch customers for dropdown
      const custRes = await fetch(`/api/portal/invoices/customers?account_id=${data.account_id}`)
      const customers = custRes.ok ? await custRes.json() : []

      setInvoice({
        accountId: data.account_id,
        customers,
        initialData: {
          id: data.id,
          customerId: data.customer_id,
          currency: data.currency,
          discount: data.discount || 0,
          issueDate: data.issue_date,
          dueDate: data.due_date || '',
          notes: data.notes || '',
          message: data.message || '',
          bankAccountId: data.bank_account_id || null,
          items: data.items.map((item: { description: string; quantity: number; unit_price: number; amount: number }) => ({
            description: item.description,
            quantity: item.quantity,
            unit_price: item.unit_price,
            amount: item.amount,
          })),
        },
      })
      setLoading(false)
    }
    load()
  }, [invoiceId])

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    )
  }

  if (!invoice) {
    return (
      <div className="p-8 text-center">
        <p className="text-zinc-500">Invoice not found or cannot be edited (only Draft invoices can be edited).</p>
        <Link href="/portal/invoices" className="text-sm text-blue-600 hover:underline mt-2 inline-block">Back to invoices</Link>
      </div>
    )
  }

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto">
      <InvoiceForm
        accountId={invoice.accountId}
        customers={invoice.customers}
        mode="edit"
        initialData={invoice.initialData}
      />
    </div>
  )
}
