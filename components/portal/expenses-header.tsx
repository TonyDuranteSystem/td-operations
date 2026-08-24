'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { UploadExpenseDialog } from './upload-expense-dialog'
import type { Vendor } from '@/app/portal/invoices/vendor-actions'
import { useLocale } from '@/lib/portal/use-locale'

export function ExpensesHeader({ accountId, vendors }: { accountId: string; vendors: Vendor[] }) {
  const { t } = useLocale()
  const [showUpload, setShowUpload] = useState(false)

  return (
    <>
      <button
        onClick={() => setShowUpload(true)}
        className="flex items-center justify-center gap-2 px-4 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors w-full sm:w-auto"
      >
        <Plus className="h-4 w-4" />
        {t('expenses.addExpense')}
      </button>
      <UploadExpenseDialog
        open={showUpload}
        onClose={() => setShowUpload(false)}
        accountId={accountId}
        vendors={vendors}
      />
    </>
  )
}
