'use client'

/**
 * MoneyInput — the shared amount box (dev job 89195c68, 2026-09-29).
 *
 * Replaces the native <input type="number"> that read an Italian "80.000"
 * (eighty thousand) as 80. Rules (council-reviewed, plan v4):
 *  - It is a TEXT box; lib/money-input.ts reads US and European formats.
 *  - Typing never rewrites the box. The text is tidied into US format only on
 *    blur, and only if the client actually edited it.
 *  - A genuinely ambiguous amount ("80.000", "1.500") is never guessed: when
 *    the client leaves the box, a question appears with two buttons that say
 *    the amount in WORDS plus how it is written in Italy, so the client never
 *    has to decode the notation they just misread.
 *  - The parent's form data holds a NUMBER once settled, and the raw typed
 *    STRING while it is not — so an unanswered question survives autosave,
 *    draft reload and Back, and the wizard's step gate can block on it.
 *  - The box re-syncs from the `value` prop only when that value differs from
 *    the last value this box sent up (a real outside change: draft load, a
 *    repeater row sliding into this slot). Repeater rows are additionally
 *    remounted on removal by the parent, so no "Saved as" line sticks to the
 *    wrong row.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  amountInWords,
  boxTextForValue,
  checkStoredMoney,
  formatMoneyItalian,
  formatMoneyUS,
  formatMoneyWithSymbol,
  parseMoneyInput,
  type MoneyCurrency,
  type MoneyParseOptions,
} from '@/lib/money-input'
import { moneyProblemMessage } from '@/lib/portal/wizard-money'

type MoneyValue = string | number | string[] | boolean | undefined | null

export interface MoneyInputProps {
  id?: string
  value: MoneyValue
  onChange: (value: number | string) => void
  /** Portal language for the amount words ('en' | 'it'). */
  locale: 'en' | 'it'
  /** True for a portal language other than EN/IT: the buttons then show only
   *  the figures (no English/Italian words mixed into their language). */
  otherLanguage?: boolean
  /** Localizer: (english, italian) → the text to show. */
  pick: (en: string, it: string) => string
  options?: MoneyParseOptions
  placeholder?: string
  /** An error from the step gate / server — shown only when the box has no
   *  message of its own to show. */
  error?: string
  className?: string
}

export function MoneyInput({
  id,
  value,
  onChange,
  locale,
  otherLanguage = false,
  pick,
  options,
  placeholder,
  error,
  className,
}: MoneyInputProps) {
  const currency: MoneyCurrency = options?.currency ?? 'USD'
  const symbol = currency === 'EUR' ? '€' : '$'
  const autoId = useId()
  const inputId = id ?? `money-${autoId}`
  const slotId = `${inputId}-slot`
  const questionId = `${inputId}-question`

  const [text, setText] = useState(() => boxTextForValue(value))
  const [focused, setFocused] = useState(false)
  const [savedAs, setSavedAs] = useState<number | null>(null)
  // True once the client has edited the text since it was last synced from
  // the prop — blur tidies ONLY edited text, never a loaded value (a legacy
  // 10.596 must stay 10.596 on screen, not silently turn into "10,596").
  const [edited, setEdited] = useState(false)
  // True while the box holds text WE formatted US-style ("80,000") and the
  // client edits it: a lone decimal comma is then refused, so deleting the
  // last digit ("80,00") is never silently read as $80. Reset once the box
  // is emptied (fresh typing may use an Italian decimal comma, "80,50").
  const [fromFormatted, setFromFormatted] = useState(() => boxTextForValue(value).includes(','))
  const parseOpts: MoneyParseOptions = { ...options, allowCommaDecimal: !fromFormatted && (options?.allowCommaDecimal ?? true) }
  const lastEmitted = useRef<MoneyValue>(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!Object.is(value, lastEmitted.current)) {
      lastEmitted.current = value
      const t = boxTextForValue(value)
      setText(t)
      setFromFormatted(t.includes(','))
      setSavedAs(null)
      setEdited(false)
    }
  }, [value])

  const emit = (v: number | string) => {
    lastEmitted.current = v
    onChange(v)
  }

  const handleChange = (t: string) => {
    setText(t)
    setEdited(true)
    setSavedAs(null)
    const commaOk = t.trim() === '' ? true : !fromFormatted
    if (t.trim() === '') setFromFormatted(false)
    const r = parseMoneyInput(t, { ...parseOpts, allowCommaDecimal: commaOk && (options?.allowCommaDecimal ?? true) })
    if (r.kind === 'ok') emit(r.value)
    else if (r.kind === 'empty') emit('')
    else emit(t)
  }

  const handleBlur = () => {
    setFocused(false)
    if (!edited) return
    const r = parseMoneyInput(text, parseOpts)
    if (r.kind !== 'ok') return
    const tidy = formatMoneyUS(r.value)
    if (tidy !== text) setText(tidy)
    setFromFormatted(tidy.includes(','))
    if (r.normalized) setSavedAs(r.value)
    setEdited(false)
  }

  const choose = (n: number) => {
    emit(n)
    const t = formatMoneyUS(n)
    setText(t)
    setFromFormatted(t.includes(','))
    setSavedAs(n)
    setEdited(false)
  }

  const retype = () => {
    emit('')
    setText('')
    setFromFormatted(false)
    setSavedAs(null)
    setEdited(false)
    inputRef.current?.focus()
  }

  const words = (n: number) => (otherLanguage ? null : amountInWords(n, locale, currency))

  const choiceLabel = (n: number, kind: 'thousands' | 'decimal') => {
    const figure = kind === 'thousands' ? `${n < 0 ? '-' : ''}${symbol}${formatMoneyUS(Math.abs(n))}` : formatMoneyWithSymbol(n, currency)
    if (otherLanguage) return figure
    const w = words(n)
    if (locale === 'it') {
      const italian = formatMoneyItalian(n, { cents: kind === 'decimal' })
      return w ? `${w} — in Italia: ${italian}` : `${figure} — in Italia: ${italian}`
    }
    return w ? `${w} — ${figure}` : figure
  }

  const savedAsLine = (n: number) => {
    const w = words(n)
    const fig = formatMoneyWithSymbol(n, currency)
    return pick(
      `Saved as ${fig}${w ? ` (${w})` : ''}.`,
      `Salvato come ${fig}${w ? ` (${w})` : ''}.`,
    )
  }

  // ── What the single slot under the box shows (one thing at a time) ──
  const parsed = parseMoneyInput(text, parseOpts)
  let slot: ReactNode = null
  let blocking = false

  if (!focused && parsed.kind === 'ambiguous') {
    blocking = true
    slot = (
      <div role="group" aria-labelledby={questionId} className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2">
        <p id={questionId} className="flex items-center gap-1.5 text-sm font-medium text-amber-900">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {pick('Which amount did you mean?', 'Quale importo intendevi?')}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button
            type="button"
            onClick={() => choose(parsed.asThousands)}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-left text-sm font-medium text-zinc-800 hover:border-blue-400 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {choiceLabel(parsed.asThousands, 'thousands')}
          </button>
          <button
            type="button"
            onClick={() => choose(parsed.asDecimal)}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-left text-sm font-medium text-zinc-800 hover:border-blue-400 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {choiceLabel(parsed.asDecimal, 'decimal')}
          </button>
        </div>
        <button
          type="button"
          onClick={retype}
          className="text-xs text-zinc-600 underline hover:text-zinc-900 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
        >
          {pick('Neither — let me retype', 'Nessuno dei due — correggo')}
        </button>
      </div>
    )
  } else if (!focused && parsed.kind === 'invalid') {
    blocking = true
    const msg =
      parsed.reason === 'negative'
        ? pick('This amount cannot be negative.', 'Questo importo non può essere negativo.')
        : parsed.reason === 'wrong_currency'
          ? currency === 'EUR'
            ? pick('Enter the amount in euros.', "Inserisci l'importo in euro.")
            : pick('Enter the amount in US dollars.', "Inserisci l'importo in dollari USA.")
          : parsed.reason === 'too_large'
            ? pick('This amount is too large. Please check it.', 'Questo importo è troppo grande. Controllalo.')
            : parsed.reason === 'too_many_decimals'
              ? pick('Use at most 2 decimals, e.g. 80000 or 80.50.', 'Usa al massimo 2 decimali, ad es. 80000 o 80.50.')
              : pick("We couldn't read this amount. Type only the digits, e.g. 80000.", 'Non riusciamo a leggere questo importo. Scrivi solo le cifre, ad es. 80000.')
    slot = (
      <p className="flex items-center gap-1 text-xs text-red-600">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {msg}
      </p>
    )
  } else if (!edited && typeof value === 'number') {
    // A stored number that no longer passes (legacy 10.596, or a negative in
    // a min-0 field) — shown unrounded above, explained here.
    const problem = checkStoredMoney(value, parseOpts)
    if (problem) {
      blocking = true
      const m = moneyProblemMessage({ problem }, text || value)
      slot = (
        <p className="flex items-center gap-1 text-xs text-red-600">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {pick(m.en, m.it)}
        </p>
      )
    }
  }
  if (!slot && savedAs !== null) {
    slot = <p className="text-xs text-emerald-700">{savedAsLine(savedAs)}</p>
  }
  // Not while the client is in the box: an "answer the question under the
  // box" error with the question hidden (it shows on blur) would contradict
  // itself.
  if (!slot && error && !focused) {
    blocking = true
    slot = <p className="text-xs text-red-500">{error}</p>
  }

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-zinc-500" aria-hidden="true">
          {symbol}
        </span>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          placeholder={placeholder}
          onChange={e => handleChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={handleBlur}
          aria-describedby={slot ? slotId : undefined}
          aria-invalid={blocking || undefined}
          className={cn(className, 'pl-7')}
        />
      </div>
      <div id={slotId} aria-live="polite">
        {slot}
      </div>
    </div>
  )
}
