'use client'

import { useState } from 'react'
import { Loader2, CheckCircle, AlertCircle, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLocale } from '@/lib/portal/use-locale'

export interface FieldConfig {
  name: string
  label: string
  labelIt?: string
  type: 'text' | 'email' | 'tel' | 'date' | 'textarea' | 'select' | 'number' | 'file' | 'checkbox' | 'country' | 'repeater' | 'multiselect'
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
  /** Always-visible strong (red) warning box above the field. Used to steer a
   *  high-stakes choice — e.g. "don't upload PDFs, they're slow and lossy". */
  danger?: { text: string; textIt?: string }
  prefilled?: boolean
  /** Domain minimum for `number` fields (e.g. 0 on money amounts — a negative
   *  dollar figure is never legitimate). Rendered as the input's min attribute
   *  AND enforced by the wizard step gate. */
  min?: number
  accept?: string                  // file input accept attribute override
  repeaterFields?: FieldConfig[]   // sub-fields for repeater type
  repeaterAddLabel?: string
  repeaterAddLabelIt?: string
  /** Repeater must have at least one row to pass the step gate (e.g. the tax
   *  per-bank CSV sections — master plan b2115fd3). Default false = optional. */
  repeaterRequired?: boolean
  /** Live-format the input as the user types. `ein` strips non-digits and
   *  auto-inserts the dash after the second digit, capped at 9 digits.
   *  Display always ends up in canonical XX-XXXXXXX regardless of what the
   *  user pastes. Phase E2. */
  format?: 'ein'
  /** Render a non-functional "✨ Generate" placeholder button beside a
   *  `textarea` (TD Communication brand-audit description). The AI wiring is a
   *  later phase — the button is disabled and only signals the intent. Ignored
   *  on non-textarea fields. */
  aiAssist?: boolean
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
  /** AI draft helper for a `field.aiAssist` textarea. Returns suggested text (the
   *  user chooses to use/append it — never auto-applied) or null on failure (the
   *  caller surfaces the error). When omitted, the ✨ button stays a disabled
   *  placeholder, so the button is inert for any wizard that doesn't wire this. */
  onAiAssist?: (field: FieldConfig, currentValue: string) => Promise<string | null>
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

export function WizardField({ field, value, onChange, onFileUpload, onAiAssist, locale, error }: WizardFieldProps) {
  // Any language beyond en/it (dev job 12cab351) — loaded translations are
  // keyed by the field's own English text (lib/portal/wizard-translatable-
  // text.ts), so this MUST be layered under the existing it/en choice, not
  // replace it: `translations` is only ever non-empty for a locale outside
  // SUPPORTED_LOCALES, and falls through to the exact same it/en behavior
  // as before whenever it has nothing for a given phrase.
  const { translations } = useLocale()
  const pick = (en: string | undefined, it: string | undefined): string | undefined => {
    if (!en) return en
    return translations[en] ?? (locale === 'it' && it ? it : en)
  }
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadStatus, setUploadStatus] = useState<{ name: string; index: number; total: number; pct: number } | null>(null)
  // ✨ AI draft state (textarea + aiAssist + onAiAssist only).
  const [aiBusy, setAiBusy] = useState(false)
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null)

  // Enabled only when a real handler is wired (TD Communication). Absent → the
  // button renders disabled (placeholder), keeping non-TD wizards inert.
  const aiEnabled = !!(field.aiAssist && onAiAssist)
  const runAiAssist = async () => {
    if (!onAiAssist || aiBusy) return
    setAiBusy(true)
    try {
      const text = await onAiAssist(field, String(value ?? ''))
      if (text) setAiSuggestion(text)
    } finally {
      setAiBusy(false)
    }
  }
  const label = pick(field.label, field.labelIt)
  const placeholder = pick(field.placeholder, field.placeholderIt)
  const hint = pick(field.hint, field.hintIt)

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
      </div>
      {field.danger && (
        <div className="rounded-lg border-2 border-red-300 bg-red-50 p-3 flex gap-2.5">
          <div className="shrink-0 flex h-7 w-7 items-center justify-center rounded-full bg-red-600 text-white text-lg font-black leading-none">!</div>
          <p className="text-xs text-red-900 leading-relaxed">
            {pick(field.danger.text, field.danger.textIt)}
          </p>
        </div>
      )}
      {/* Always-visible field explanation — replaces the old click-to-reveal
          "i" tooltip. People don't click info icons, so guidance that matters
          (e.g. the $25k related-party question) must be on screen by default. */}
      {hint && field.type !== 'checkbox' && (
        <p className="text-xs text-zinc-500 leading-relaxed">{hint}</p>
      )}

      {field.type === 'textarea' ? (
        <div className="space-y-2">
          <div className="relative">
            <textarea
              value={String(value ?? '')}
              onChange={e => onChange(field.name, e.target.value)}
              placeholder={placeholder}
              rows={3}
              className={cn(inputClass, 'resize-none', field.aiAssist && 'pr-28')}
            />
            {field.aiAssist && (
              aiEnabled ? (
                <button
                  type="button"
                  onClick={runAiAssist}
                  disabled={aiBusy}
                  title={locale === 'it' ? 'Genera una bozza con l’AI' : 'Draft an answer with AI'}
                  className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-60 disabled:cursor-wait"
                >
                  {aiBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <span>✨</span>}
                  {aiBusy ? (locale === 'it' ? 'Genero…' : 'Drafting…') : (locale === 'it' ? 'Genera' : 'Generate')}
                </button>
              ) : (
                <button
                  type="button"
                  disabled
                  title={locale === 'it' ? 'Generazione AI — in arrivo' : 'AI generation — coming soon'}
                  className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] font-medium text-zinc-400 cursor-not-allowed"
                >
                  ✨ {locale === 'it' ? 'Genera' : 'Generate'}
                </button>
              )
            )}
          </div>

          {/* AI suggestion preview — the client chooses to use/append it; the
              draft is NEVER auto-written into the field (enhance, not replace). */}
          {aiSuggestion !== null && (
            <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-blue-600">
                ✨ {locale === 'it' ? 'Bozza suggerita' : 'Suggested draft'}
              </p>
              <p className="text-sm text-zinc-800 whitespace-pre-wrap">{aiSuggestion}</p>
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={() => { onChange(field.name, aiSuggestion); setAiSuggestion(null) }}
                  className="inline-flex items-center rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700"
                >
                  {locale === 'it' ? 'Usa questa' : 'Use this'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const cur = String(value ?? '').trim()
                    onChange(field.name, cur ? `${cur}\n\n${aiSuggestion}` : aiSuggestion)
                    setAiSuggestion(null)
                  }}
                  className="inline-flex items-center rounded-md border border-blue-300 bg-white px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50"
                >
                  {locale === 'it' ? 'Aggiungi alla risposta' : 'Add to my answer'}
                </button>
                <button
                  type="button"
                  onClick={runAiAssist}
                  disabled={aiBusy}
                  className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-60"
                >
                  {aiBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                  {locale === 'it' ? 'Rigenera' : 'Regenerate'}
                </button>
                <button
                  type="button"
                  onClick={() => setAiSuggestion(null)}
                  className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium text-zinc-400 hover:text-zinc-600"
                >
                  {locale === 'it' ? 'Ignora' : 'Dismiss'}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : field.type === 'multiselect' ? (
        (() => {
          // Multi-select stores a string[] of chosen option values. Legacy/empty
          // values coerce to []. Toggling adds/removes the option value.
          const selected: string[] = Array.isArray(value)
            ? value.map(String)
            : (value ? [String(value)] : [])
          return (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {field.options?.map(opt => {
                const checked = selected.includes(opt.value)
                return (
                  <label
                    key={opt.value}
                    className={cn(
                      'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer transition-colors',
                      checked ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-zinc-200 text-zinc-600 hover:border-zinc-300',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = checked
                          ? selected.filter(v => v !== opt.value)
                          : [...selected, opt.value]
                        onChange(field.name, next)
                      }}
                      className="h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="truncate">{pick(opt.label, opt.labelIt)}</span>
                  </label>
                )
              })}
            </div>
          )
        })()
      ) : field.type === 'select' ? (
        <select
          value={String(value ?? '')}
          onChange={e => onChange(field.name, e.target.value)}
          className={inputClass}
        >
          <option value="">{locale === 'it' ? 'Seleziona...' : 'Select...'}</option>
          {field.options?.map(opt => (
            <option key={opt.value} value={opt.value}>
              {pick(opt.label, opt.labelIt)}
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
          // client sees their original filename. Inside repeaters the storage
          // path uses the FLATTENED name (bank_accounts_0_statements_…) while
          // field.name is just the sub-field ("statements"), so a name-anchored
          // regex misses — strip generically through the 8-char unique token.
          const displayName = (p: string) => {
            const base = p.split('/').pop() || p
            const generic = base.replace(/^.*_[a-z0-9]{8}_/, '')
            if (generic !== base) return generic
            return base.replace(new RegExp(`^${field.name}_`), '')
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
                  // R099: when the server rejects a file it sends a guiding
                  // message (e.g. the CSV-only explanation) — show THAT, not a
                  // generic "Upload failed".
                  let serverMessage: string | null = null
                  for (let i = 0; i < selected.length; i++) {
                    const f = selected[i]
                    setUploadStatus({ name: f.name, index: i + 1, total: selected.length, pct: 0 })
                    try {
                      const path = await onFileUpload(field.name, f, pct =>
                        setUploadStatus({ name: f.name, index: i + 1, total: selected.length, pct }),
                      )
                      if (path) uploaded.push(path)
                      else failed.push(f.name)
                    } catch (err) {
                      failed.push(f.name)
                      if (err instanceof Error && err.message) serverMessage = err.message
                    }
                  }
                  setUploading(false)
                  setUploadStatus(null)
                  if (uploaded.length > 0) onChange(field.name, [...paths, ...uploaded])
                  if (failed.length > 0) {
                    setUploadError(
                      serverMessage
                        ?? (locale === 'it'
                          ? `Caricamento fallito: ${failed.join(', ')}`
                          : `Upload failed: ${failed.join(', ')}`),
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
          min={field.type === 'number' ? field.min : undefined}
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

      {field.type === 'number' && field.min !== undefined && value !== '' && value !== null && value !== undefined &&
        !Number.isNaN(Number(value)) && Number(value) < field.min && (
        <p className="text-xs text-red-500">
          {field.min === 0
            ? (locale === 'it' ? 'Questo importo non può essere negativo.' : 'This amount cannot be negative.')
            : (locale === 'it' ? `Deve essere almeno ${field.min}.` : `Must be at least ${field.min}.`)}
        </p>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}
