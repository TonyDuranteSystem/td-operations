'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { UploadExpenseDialog } from './upload-expense-dialog'
import type { Vendor } from '@/app/portal/invoices/vendor-actions'
import { useLocale } from '@/lib/portal/use-locale'

export function ExpensesHeader({ accountId, vendors, round = false }: { accountId: string; vendors: Vendor[]; /** The client iPhone app: a round dark "+" in the area header instead of the wide blue button. */ round?: boolean }) {
  const { t } = useLocale()
  const [showUpload, setShowUpload] = useState(false)

  return (
    <>
      {round ? (
        <button
          type="button"
          onClick={() => setShowUpload(true)}
          data-testid="app-area-new"
          aria-label={t('expenses.addExpense')}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-white"
        >
          <Plus className="h-5 w-5" aria-hidden="true" />
        </button>
      ) : (
      <button
        onClick={() => setShowUpload(true)}
        className="flex items-center justify-center gap-2 px-4 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors w-full sm:w-auto"
      >
        <Plus className="h-4 w-4" />
        {t('expenses.addExpense')}
      </button>
      )}
      <UploadExpenseDialog
        open={showUpload}
        onClose={() => setShowUpload(false)}
        accountId={accountId}
        vendors={vendors}
      />
    </>
  )
}
