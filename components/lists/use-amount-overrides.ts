'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ListAmountField } from '@/lib/crm-lists/amounts'

export interface SavedAmount {
  accountId: string
  field: ListAmountField
  /** The saved number (null when cleared). */
  amount: number | null
  updatedAt?: string
}

export type AmountOverride = Partial<Record<ListAmountField, number | null>> & { updated_at?: string }

/**
 * Amounts just saved in a list, held until the server sends the refreshed page. They make Per year (and every other line of
 * the same company) change the instant a save succeeds, and they carry the company's NEW updated_at so a second edit on the same
 * company is not mistaken for a stale one. `resetKey` is the page's `items` array: a fresh page from the server replaces them.
 */
export function useAmountOverrides(resetKey: unknown) {
  const [overrides, setOverrides] = useState<Record<string, AmountOverride>>({})

  useEffect(() => {
    setOverrides({})
  }, [resetKey])

  const apply = useCallback((saved: SavedAmount) => {
    setOverrides((prev) => ({
      ...prev,
      [saved.accountId]: {
        ...prev[saved.accountId],
        [saved.field]: saved.amount,
        ...(saved.updatedAt ? { updated_at: saved.updatedAt } : {}),
      },
    }))
  }, [])

  return { overrides, apply }
}
