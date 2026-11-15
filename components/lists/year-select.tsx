'use client'

/**
 * "Invoice year": which year's installment invoice the Paid / Pending / Overdue chips look at. The amounts do not change with it.
 */
export function YearSelect({
  year,
  years,
  onChange,
  disabled,
}: {
  year: number
  years: number[]
  onChange: (year: number) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="invoice-year" className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Invoice year
      </label>
      <select
        id="invoice-year"
        value={year}
        disabled={disabled}
        onChange={e => onChange(Number(e.target.value))}
        className="rounded-lg border bg-white px-2.5 py-1.5 text-xs font-semibold text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {years.map(y => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </div>
  )
}
