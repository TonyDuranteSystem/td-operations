'use client'

import { useState } from 'react'
import { Loader2, CheckCircle, AlertCircle, Info, X } from 'lucide-react'
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
  /** Show an amber warning box below the field when its current value equals
   *  `value`. Used to make a high-stakes answer explicit to the client (e.g. a
   *  "No" to the related-party question that carries a $25,000 IRS penalty). */
  warningOnValue?: { value: string; text: string; textIt?: string }
  prefilled?: boolean
  accept?: string                  // file input accept attribute override
  repeaterFields?: FieldConfig[]   // sub-fields for repeater type
  repeaterAddLabel?: string
  repeaterAddLabelIt?: string
  /** Live-format the input as the user types. `ein` strips non-digits and
   *  auto-inserts the dash after the second digit, capped at 9 digits.
   *  Display always ends up in canonical XX-XXXXXXX regardless of what the
   *  user pastes. Phase E2. */
  format?: 'ein'
}

/** Live-normalize an EIN-like input. Accepts any input, returns at most 9
 *  digits formatted as XX-XXXXXXX. Silent on non-digits. Matches the
 *  server-side normalizeEIN() so client + server agree on shape. */
function formatEINInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 9)
  if (digits.length <= 2) return digits
  return `${digits.slice(0, 2)}-${digits.slice(2)}`
}

interface WizardFieldProps {
  field: FieldConfig
  value: string | string[] | boolean | number
  onChange: (name: string, value: string | string[] | boolean | number) => void
  onFileUpload?: (name: string, file: File, onProgress?: (pct: number) => void) => Promise<string | null> // returns storage path or null on error
  locale: 'en' | 'it'
  error?: string
}

// Full ISO 3166-1 country list (195 countries)
const COUNTRIES = [
  'Afghanistan','Albania','Algeria','Andorra','Angola','Antigua and Barbuda','Argentina','Armenia','Australia','Austria',
  'Azerbaijan','Bahamas','Bahrain','Bangladesh','Barbados','Belarus','Belgium','Belize','Benin','Bhutan',
  'Bolivia','Bosnia and Herzegovina','Botswana','Brazil','Brunei','Bulgaria','Burkina Faso','Burundi','Cabo Verde','Cambodia',
  'Cameroon','Canada','Central African Republic','Chad','Chile','China','Colombia','Comoros','Congo (Brazzaville)','Congo (DRC)',
  'Costa Rica','Croatia','Cuba','Cyprus','Czech Republic','Denmark','Djibouti','Dominica','Dominican Republic','Ecuador',
  'Egypt','El Salvador','Equatorial Guinea','Eritrea','Estonia','Eswatini','Ethiopia','Fiji','Finland','France',
  'Gabon','Gambia','Georgia','Germany','Ghana','Greece','Grenada','Guatemala','Guinea','Guinea-Bissau',
  'Guyana','Haiti','Honduras','Hungary','Iceland','India','Indonesia','Iran','Iraq','Ireland',
  'Israel','Italy','Ivory Coast','Jamaica','Japan','Jordan','Kazakhstan','Kenya','Kiribati','Kosovo',
  'Kuwait','Kyrgyzstan','Laos','Latvia','Lebanon','Lesotho','Liberia','Libya','Liechtenstein','Lithuania',
  'Luxembourg','Madagascar','Malawi','Malaysia','Maldives','Mali','Malta','Marshall Islands','Mauritania','Mauritius',
  'Mexico','Micronesia','Moldova','Monaco','Mongolia','Montenegro','Morocco','Mozambique','Myanmar','Namibia',
  'Nauru','Nepal','Netherlands','New Zealand','Nicaragua','Niger','Nigeria','North Korea','North Macedonia','Norway',
  'Oman','Pakistan','Palau','Palestine','Panama','Papua New Guinea','Paraguay','Peru','Philippines','Poland',
  'Portugal','Qatar','Romania','Russia','Rwanda','Saint Kitts and Nevis','Saint Lucia','Saint Vincent and the Grenadines',
  'Samoa','San Marino','Sao Tome and Principe','Saudi Arabia','Senegal','Serbia','Seychelles','Sierra Leone','Singapore',
  'Slovakia','Slovenia','Solomon Islands','Somalia','South Africa','South Korea','South Sudan','Spain','Sri Lanka','Sudan',
  'Suriname','Sweden','Switzerland','Syria','Taiwan','Tajikistan','Tanzania','Thailand','Timor-Leste','Togo',
  'Tonga','Trinidad and Tobago','Tunisia','Turkey','Turkmenistan','Tuvalu','Uganda','Ukraine','United Arab Emirates','United Kingdom',
  'United States','Uruguay','Uzbekistan','Vanuatu','Vatican City','Venezuela','Vietnam','Yemen','Zambia','Zimbabwe',
].sort()

export function WizardField({ field, value, onChange, onFileUpload, locale, error }: WizardFieldProps) {
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadStatus, setUploadStatus] = useState<{ name: string; index: number; total: number; pct: number } | null>(null)
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
          value={String(value ?? '')}
          onChange={e => onChange(field.name, e.target.value)}
          placeholder={placeholder}
          rows={3}
          className={cn(inputClass, 'resize-none')}
        />
      ) : field.type === 'select' ? (
        <select
          value={String(value ?? '')}
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
          value={String(value ?? '')}
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
        (() => {
          // File fields store an ARRAY of storage paths (multi-file). Legacy
          // single-string values are coerced to a one-element list so old
          // in-flight drafts still render. dev_task 64bfcdd9.
          const paths = Array.isArray(value) ? value : (value ? [String(value)] : [])
          // Strip the storage prefix + the {fieldName}_{unique}_ segment so the
          // client sees their original filename.
          const displayName = (p: string) => {
            const base = p.split('/').pop() || p
            return base.replace(new RegExp(`^${field.name}_[a-z0-9]{8}_`), '')
          }
          return (
            <div className="space-y-1.5">
              <input
                type="file"
                multiple
                onChange={async e => {
                  const selected = Array.from(e.target.files ?? [])
                  // Reset so picking the same file again (or adding more) re-fires onChange.
                  e.target.value = ''
                  if (selected.length === 0) return
                  setUploadError(null)
                  if (!onFileUpload) {
                    onChange(field.name, [...paths, ...selected.map(f => f.name)])
                    return
                  }
                  setUploading(true)
                  const uploaded: string[] = []
                  const failed: string[] = []
                  for (let i = 0; i < selected.length; i++) {
                    const f = selected[i]
                    setUploadStatus({ name: f.name, index: i + 1, total: selected.length, pct: 0 })
                    const path = await onFileUpload(field.name, f, pct =>
                      setUploadStatus({ name: f.name, index: i + 1, total: selected.length, pct }),
                    )
                    if (path) uploaded.push(path)
                    else failed.push(f.name)
                  }
                  setUploading(false)
                  setUploadStatus(null)
                  if (uploaded.length > 0) onChange(field.name, [...paths, ...uploaded])
                  if (failed.length > 0) {
                    setUploadError(
                      locale === 'it'
                        ? `Caricamento fallito: ${failed.join(', ')}`
                        : `Upload failed: ${failed.join(', ')}`,
                    )
                  }
                }}
                disabled={uploading}
                accept={field.accept}
                className="w-full text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:font-medium file:cursor-pointer hover:file:bg-blue-100 disabled:opacity-50"
              />
              {uploading && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-xs text-blue-600">
                    <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                    <span className="truncate">
                      {uploadStatus
                        ? `${locale === 'it' ? 'Caricamento' : 'Uploading'} ${uploadStatus.name}${uploadStatus.total > 1 ? ` (${uploadStatus.index}/${uploadStatus.total})` : ''} — ${uploadStatus.pct}%`
                        : (locale === 'it' ? 'Caricamento...' : 'Uploading...')}
                    </span>
                  </div>
                  {uploadStatus && (
                    <div className="h-1 w-full rounded bg-blue-100 overflow-hidden">
                      <div className="h-full bg-blue-500 transition-all" style={{ width: `${uploadStatus.pct}%` }} />
                    </div>
                  )}
                </div>
              )}
              {paths.length > 0 && (
                <ul className="space-y-1">
                  {paths.map((p, i) => (
                    <li
                      key={`${p}-${i}`}
                      className="flex items-center justify-between gap-2 text-xs text-green-700 bg-green-50 border border-green-100 rounded px-2 py-1"
                    >
                      <span className="flex items-center gap-1 min-w-0">
                        <CheckCircle className="h-3 w-3 shrink-0" />
                        <span className="truncate">{displayName(p)}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => onChange(field.name, paths.filter((_, j) => j !== i))}
                        className="text-zinc-400 hover:text-red-500 shrink-0"
                        aria-label={locale === 'it' ? 'Rimuovi file' : 'Remove file'}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {uploadError && (
                <div className="flex items-center gap-1 text-xs text-red-500">
                  <AlertCircle className="h-3 w-3" />
                  {uploadError}
                </div>
              )}
            </div>
          )
        })()
      ) : (
        <input
          type={field.type}
          value={String(value ?? '')}
          inputMode={field.format === 'ein' ? 'numeric' : undefined}
          maxLength={field.format === 'ein' ? 10 : undefined}
          onChange={e => {
            const raw = e.target.value
            if (field.format === 'ein') {
              onChange(field.name, formatEINInput(raw))
              return
            }
            onChange(field.name, field.type === 'number' ? (raw === '' ? '' : Number(raw)) : raw)
          }}
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
