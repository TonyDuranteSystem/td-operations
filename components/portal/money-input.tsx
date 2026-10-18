'use client'

import { useEffect, useState } from 'react'
import { cleanMoneyText, moneyNumberToText, moneyTextToNumber } from '@/lib/portal/money-input'

/** A price / discount box that starts empty instead of with a 0 that never goes away. */
export function MoneyInput({ value, onChange, className, testId }: {
  value: number
  onChange: (n: number) => void
  className?: string
  testId?: string
}) {
  const [text, setText] = useState(moneyNumberToText(value))

  // A value that changes from outside (a template, editing an invoice) replaces the text; our own typing never does.
  useEffect(() => {
    setText(prev => (moneyTextToNumber(prev) === value ? prev : moneyNumberToText(value)))
  }, [value])

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      placeholder="0.00"
      data-testid={testId}
      onChange={e => {
        const next = cleanMoneyText(e.target.value)
        if (next === null) return
        setText(next)
        onChange(moneyTextToNumber(next))
      }}
      className={className}
    />
  )
}
