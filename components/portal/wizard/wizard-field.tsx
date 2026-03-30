'use client'

import { useState } from 'react'
import { Loader2, CheckCircle, AlertCircle, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface FieldConfig {
  name: string
  label: string
  labelIt?: string
  type: 'text' | 'email' | 'tel' | 'date' | 'textarea' | 'select' | 'number' | 'file' | 'checkbox' | 'country' | 'repeater'
  required?: boolean
  placeholder?: string
  placeholderIt?: string
  options?: { value: string; label: string; labelIt?: string }[]
  hint?: string
  hintIt?: string
  conditional?: { field: string; value: string } // only show if another field has this value
  prefilled?: boolean
  accept?: string                  // file input accept attribute override
  repeaterFields?: FieldConfig[]   // sub-fields for repeater type
  repeaterAddLabel?: string
  repeaterAddLabelIt?: string
}

interface WizardFieldProps {
  field: FieldConfig
  value: string | boolean | number
  onChange: (name: string, value: string | boolean | number) => void
  onFileUpload?: (name: string, file: File) => Promise<string | null> // returns storage path or null on error
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

export function WizardField({ field, value, onChange, onFileUpload, locale, error }: WizardFieldProps) {
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [showHint, setShowHint] = useState(false)
  const label = locale === 'it' && field.labelIt ? field.labelIt : field.label
  const placeholder = locale === 'it' && field.placeholderIt ? field.placeholderIt : field.placeholder
  const hint = locale === 'it' && field.hintIt ? field.hintIt : field.hint

  // repeater fields are rendered by wizard-client, not here
  if (field.type === 'repeater') return null

  const inputClass = cn(
    'w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors',
    error ? 'border-red-300 focus:ring-red-500' : 'border-zinc-200',
    field.prefilled && value && 'bg-blue-50/50 border-blue-200',
  )

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <label className="flex items-center gap-1 text-sm font-medium text-zinc-700">
          {label}
          {field.required && <span className="text-red-500">*</span>}
          {field.prefilled && value && (
            <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded-full font-normal">
              {locale === 'it' ? 'Pre-compilato' : 'Pre-filled'}
            </span>
          )}
        </label>
        {hint && field.type !== 'checkbox' && (
          <button
            type="button"
            onClick={() => setShowHint(s => !s)}
            className={cn(
              'ml-0.5 rounded-full transition-colors',
              showHint ? 'text-blue-600' : 'text-zinc-300 hover:text-zinc-500',
            )}
            aria-label="More information"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

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
        <div className="space-y-1">
          <input
            type="file"
            onChange={async e => {
              const file = e.target.files?.[0]
              if (!file) return
              if (file.size > 10 * 1024 * 1024) {
                setUploadError(locale === 'it' ? 'File troppo grande (max 10MB)' : 'File too large (max 10MB)')
                return
              }
              setUploadError(null)
              if (onFileUpload) {
                setUploading(true)
                const path = await onFileUpload(field.name, file)
                setUploading(false)
                if (path) {
                  onChange(field.name, path)
                } else {
                  setUploadError(locale === 'it' ? 'Upload fallito' : 'Upload failed')
                }
              } else {
                onChange(field.name, file.name)
              }
            }}
            disabled={uploading}
            accept={field.accept ?? '.pdf,.jpg,.jpeg,.png,.heic'}
            className="w-full text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:font-medium file:cursor-pointer hover:file:bg-blue-100 disabled:opacity-50"
          />
          {uploading && (
            <div className="flex items-center gap-2 text-xs text-blue-600">
              <Loader2 className="h-3 w-3 animate-spin" />
              {locale === 'it' ? 'Caricamento...' : 'Uploading...'}
            </div>
          )}
          {value && !uploading && !uploadError && (
            <div className="flex items-center gap-1 text-xs text-green-600">
              <CheckCircle className="h-3 w-3" />
              {locale === 'it' ? 'File caricato' : 'File uploaded'}
            </div>
          )}
          {uploadError && (
            <div className="flex items-center gap-1 text-xs text-red-500">
              <AlertCircle className="h-3 w-3" />
              {uploadError}
            </div>
          )}
        </div>
      ) : (
        <input
          type={field.type}
          value={String(value || '')}
          onChange={e => onChange(field.name, field.type === 'number' ? Number(e.target.value) : e.target.value)}
          placeholder={placeholder}
          className={inputClass}
        />
      )}

      {showHint && hint && field.type !== 'checkbox' && (
        <p className="text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded px-2 py-1.5 leading-relaxed">{hint}</p>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}
