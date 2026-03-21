'use client'

import { cn } from '@/lib/utils'

export interface FieldConfig {
  name: string
  label: string
  labelIt?: string
  type: 'text' | 'email' | 'tel' | 'date' | 'textarea' | 'select' | 'number' | 'file' | 'checkbox' | 'country'
  required?: boolean
  placeholder?: string
  placeholderIt?: string
  options?: { value: string; label: string; labelIt?: string }[]
  hint?: string
  hintIt?: string
  conditional?: { field: string; value: string } // only show if another field has this value
  prefilled?: boolean
}

interface WizardFieldProps {
  field: FieldConfig
  value: string | boolean | number
  onChange: (name: string, value: string | boolean | number) => void
  locale: 'en' | 'it'
  error?: string
}

// Common countries for nationality/citizenship dropdowns
const COUNTRIES = [
  'Italy', 'United States', 'Germany', 'France', 'Spain', 'United Kingdom',
  'Brazil', 'Argentina', 'Colombia', 'Mexico', 'Canada', 'Australia',
  'Switzerland', 'Netherlands', 'Belgium', 'Portugal', 'Austria', 'Sweden',
  'Norway', 'Denmark', 'Finland', 'Ireland', 'Poland', 'Romania',
  'Czech Republic', 'Greece', 'Turkey', 'Israel', 'India', 'China',
  'Japan', 'South Korea', 'South Africa', 'Nigeria', 'Egypt',
  'United Arab Emirates', 'Saudi Arabia', 'Russia', 'Ukraine',
].sort()

export function WizardField({ field, value, onChange, locale, error }: WizardFieldProps) {
  const label = locale === 'it' && field.labelIt ? field.labelIt : field.label
  const placeholder = locale === 'it' && field.placeholderIt ? field.placeholderIt : field.placeholder
  const hint = locale === 'it' && field.hintIt ? field.hintIt : field.hint

  const inputClass = cn(
    'w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors',
    error ? 'border-red-300 focus:ring-red-500' : 'border-zinc-200',
    field.prefilled && value && 'bg-blue-50/50 border-blue-200',
  )

  return (
    <div className="space-y-1">
      <label className="flex items-center gap-1 text-sm font-medium text-zinc-700">
        {label}
        {field.required && <span className="text-red-500">*</span>}
        {field.prefilled && value && (
          <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded-full font-normal">
            {locale === 'it' ? 'Pre-compilato' : 'Pre-filled'}
          </span>
        )}
      </label>

      {field.type === 'textarea' ? (
        <textarea
          value={String(value || '')}
          onChange={e => onChange(field.name, e.target.value)}
          placeholder={placeholder}
          rows={3}
          className={cn(inputClass, 'resize-none')}
        />
      ) : field.type === 'select' ? (
        <select
          value={String(value || '')}
          onChange={e => onChange(field.name, e.target.value)}
          className={inputClass}
        >
          <option value="">{locale === 'it' ? 'Seleziona...' : 'Select...'}</option>
          {field.options?.map(opt => (
            <option key={opt.value} value={opt.value}>
              {locale === 'it' && opt.labelIt ? opt.labelIt : opt.label}
            </option>
          ))}
        </select>
      ) : field.type === 'country' ? (
        <select
          value={String(value || '')}
          onChange={e => onChange(field.name, e.target.value)}
          className={inputClass}
        >
          <option value="">{locale === 'it' ? 'Seleziona paese...' : 'Select country...'}</option>
          {COUNTRIES.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      ) : field.type === 'checkbox' ? (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!!value}
            onChange={e => onChange(field.name, e.target.checked)}
            className="h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-sm text-zinc-600">{hint}</span>
        </label>
      ) : field.type === 'file' ? (
        <input
          type="file"
          onChange={e => {
            const file = e.target.files?.[0]
            if (file) onChange(field.name, file.name)
          }}
          accept=".pdf,.jpg,.jpeg,.png,.heic"
          className="w-full text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:font-medium file:cursor-pointer hover:file:bg-blue-100"
        />
      ) : (
        <input
          type={field.type}
          value={String(value || '')}
          onChange={e => onChange(field.name, field.type === 'number' ? Number(e.target.value) : e.target.value)}
          placeholder={placeholder}
          className={inputClass}
        />
      )}

      {hint && field.type !== 'checkbox' && (
        <p className="text-xs text-zinc-400">{hint}</p>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}
