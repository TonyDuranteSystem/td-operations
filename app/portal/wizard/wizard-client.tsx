'use client'

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { toast } from 'sonner'
import { WizardShell, type WizardStep } from '@/components/portal/wizard/wizard-shell'
import { WizardField, type FieldConfig } from '@/components/portal/wizard/wizard-field'
import { getWizardConfig, wizardCollectsOwnerMembers, wizardRequiresSs4Signer, OWNER_ITIN_FIELD, MEMBER_ITIN_FIELD, TAX_MEMBER_FIELDS } from '@/components/portal/wizard/wizard-configs'
import { useLocale } from '@/lib/portal/use-locale'
import { createClient } from '@/lib/supabase/client'
import { resolveInstitution } from '@/lib/tax/bank-identity'
import { interpolateString } from '@/lib/template-interpolation'
import { WIZARD_UPLOAD_MAX_FILE_SIZE_BYTES, wizardUploadTooLargeMessage } from '@/lib/portal/wizard-uploads'
import { AlertCircle, CheckCircle, Lock, Pencil, Plus, Trash2 } from 'lucide-react'

const UPLOAD_BUCKET = 'onboarding-uploads'

interface FieldError {
  field: string
  message: string
}

/**
 * Radio selector for the SS-4 Responsible Party (the signer) in the MMLLC
 * formation wizard. Rendered once on the owner step and once per additional
 * member; all instances share the parent's signerIndex so exactly one is
 * selectable. dev_task — MMLLC workspace enhancements.
 */
function SignerRadio({
  checked,
  onSelect,
  label,
  hint,
}: {
  checked: boolean
  onSelect: () => void
  label: string
  hint?: string
}) {
  return (
    <label
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
        checked ? 'border-blue-500 bg-blue-50' : 'border-zinc-200 hover:border-zinc-300'
      }`}
    >
      <input
        type="radio"
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 h-4 w-4 accent-blue-600"
      />
      <span className="text-sm">
        <span className="font-medium text-zinc-800">{label}</span>
        {hint && <span className="block text-xs text-zinc-500 mt-0.5">{hint}</span>}
      </span>
    </label>
  )
}

interface WizardClientProps {
  wizardType: string
  entityType: string
  /** Formation only: the signed contract and the offer both failed to say
   * whether this is a one-owner or multi-owner company. The wizard asks the
   * client ONE question before rendering rather than guessing single-member —
   * guessing is the defect this replaces (dev job fc69557f). The signed
   * contract still governs what is finally RECORDED; this only shapes the form. */
  entityUnresolved?: boolean
  prefillData: Record<string, string>
  savedData: Record<string, string>
  savedStep: number
  progressId: string | null
  accountId: string
  contactId: string
  /** Set for a formation wizard scoped to a NEW company's lead (no account yet). */
  leadId: string
  locale: 'en' | 'it'
  /** Status of a previous submission (if any) */
  initialSubmitStatus?: 'in_progress' | 'submitted' | null
  /** Locked when Antonio has reviewed — no more editing allowed */
  isLocked?: boolean
  /** How many ITINs the offer bundled (start-at-wizard). 0 = no ITIN question.
   * When > 0 the wizard asks who applies and requires exactly this many "Yes". */
  itinCount?: number
  /** Bank CSV-export guides (catalog-driven, §3.1/§8): shown under a bank
   * upload card when the typed bank name matches a guide's match terms. */
  bankGuides?: Array<{ name: string; matchTerms: string[]; stepsEn: string[]; stepsIt: string[]; noteEn: string; noteIt: string }>
  /** Identity build (2026-08-13): the LIVE institution registry — each bank
   * row resolves its identity mode from it (banks require the account number;
   * currency/crypto services never ask). Empty = seed fallback inside
   * resolveInstitution's default. */
  institutions?: Array<{ canonical: string; mode: 'account_number' | 'currency' | 'crypto'; matchTerms: string[] }>
  /** DB-driven wizard config. When provided (TD Communication brand audit,
   * built server-side from td_comm_questions), it REPLACES the code-side
   * getWizardConfig() output. Every wizard type without a DB source leaves this
   * undefined and keeps the synchronous static config. */
  configOverride?: { steps: WizardStep[]; fields: Record<string, FieldConfig[]> }
}

// A conditional field is visible only if its condition matches AND its parent
// field is itself visible — the WHOLE ancestor chain must hold. Without this,
// a child kept demanding its upload after the grandparent flipped to No: the
// parent's stale answer stayed in the draft, the child checked only its direct
// parent, and Next blocked on an invisible field (crypto-CSV repro:
// answer 1099=No, then crypto=No). Pure module-level — no hook deps.
function isFieldVisible(field: FieldConfig, stepFields: FieldConfig[], data: Record<string, unknown>, depth = 0): boolean {
  if (!field.conditional || depth > 10) return true
  if (String(data[field.conditional.field]) !== field.conditional.value) return false
  const parent = stepFields.find(f => f.name === field.conditional!.field)
  return parent ? isFieldVisible(parent, stepFields, data, depth + 1) : true
}

// A filled number below the field's domain minimum (e.g. a negative money
// amount) blocks the step even when the field is optional. Empty values are
// the required-check's business, not this one's. Pure module-level — no hook deps.
function belowFieldMin(field: { min?: number }, val: unknown): boolean {
  if (field.min === undefined) return false
  if (val === undefined || val === null || val === '' || typeof val === 'boolean') return false
  const n = Number(val)
  return !Number.isNaN(n) && n < field.min
}

type BankGuide = { name: string; matchTerms: string[]; stepsEn: string[]; stepsIt: string[]; noteEn: string; noteIt: string }

/** "Before You Start" step: tells the client to upload their transactions as a
 *  CSV and gives a bank-name lookup with the exact CSV-download steps. The P&L /
 *  Balance Sheet we build from it is a gift — but only if they bring clean data. */
type FetchedGuide = { name: string; steps: string[]; note: string }

function PrepareCsvStep({ locale, bankGuides, acknowledged, onAcknowledge }: { locale: string; bankGuides: BankGuide[]; acknowledged: boolean; onAcknowledge: (v: boolean) => void }) {
  const [bank, setBank] = useState('')
  const [fetched, setFetched] = useState<FetchedGuide | null>(null)
  const [loading, setLoading] = useState(false)
  const it = locale === 'it'
  // Any language beyond en/it (dev job 12cab351) — same pattern as
  // WizardClient's own pickText, defined locally here since this is a
  // separate component with no access to the parent's callback.
  const { translations } = useLocale()
  const pick = (en: string, itText: string): string => translations[en] ?? (it ? itText : en)
  const q = bank.toLowerCase().trim()
  const localGuide = q.length >= 3 ? bankGuides.find(g => g.matchTerms.some(t => q.includes(t))) : null
  // A locally-matched (curated) guide always wins. Otherwise show whatever the
  // server returned for the bank the client looked up.
  const guide = localGuide
    ? {
        name: localGuide.name,
        steps: it && localGuide.stepsIt.length > 0 ? localGuide.stepsIt : localGuide.stepsEn,
        note: it && localGuide.noteIt ? localGuide.noteIt : localGuide.noteEn,
      }
    : fetched
  const gSteps = guide ? guide.steps : []
  const gNote = guide ? guide.note : ''

  // When the client looks up a bank we don't already have curated steps for,
  // ask the server (catalog → AI → generic). Never throws to the user.
  async function lookup() {
    const term = bank.trim()
    if (term.length < 2 || loading) return
    setLoading(true)
    setFetched(null)
    try {
      const res = await fetch('/api/portal/bank-guide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bank: term, locale: it ? 'it' : 'en' }),
      })
      const data = await res.json().catch(() => null)
      if (data?.guide?.steps?.length) setFetched(data.guide as FetchedGuide)
    } catch {
      /* generic guidance is shown via the empty-state hint */
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="space-y-5">
      <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-5 shadow-sm">
        <p className="text-lg font-bold text-amber-900">
          {pick('⚠️ Read this carefully before you start', '⚠️ Leggi attentamente prima di iniziare')}
        </p>
        <div className="mt-3 space-y-2.5 text-sm leading-relaxed text-amber-950">
          <p>
            {pick(
              'As part of your tax return, WE prepare your Profit & Loss (P&L) and Balance Sheet for you — the complete financial picture of your company.',
              'Come parte della tua dichiarazione, prepariamo NOI per te il Conto Economico (P&L) e lo Stato Patrimoniale (Balance Sheet) della tua azienda.',
            )}
          </p>
          <p>
            {pick(
              'These are built directly from your bank statements, so they must be as accurate and complete as possible. If any transactions are missing, your P&L, Balance Sheet and tax return will be wrong.',
              'Questi documenti vengono costruiti direttamente dai tuoi estratti conto bancari, quindi devono essere il più accurati e completi possibile. Se mancano dei movimenti, il tuo P&L, lo Stato Patrimoniale e la tua dichiarazione saranno errati.',
            )}
          </p>
          <p className="font-semibold">
            {pick(
              '👉 Before you start the questionnaire, download ALL of your bank statements for the full year — for every bank and every currency — and save them on your device. You will upload them during this process.',
              '👉 Prima di iniziare il questionario, scarica TUTTI i tuoi estratti conto dell’intero anno — per ogni banca e ogni valuta — e salvali sul tuo dispositivo. Li caricherai durante questa procedura.',
            )}
          </p>
          <p className="text-xs text-amber-800">
            {pick(
              'Tip: CSV is the most reliable format. Use the lookup below to see exactly how to download it from your bank.',
              'Suggerimento: il formato CSV è il più affidabile. Usa la ricerca qui sotto per sapere come scaricarlo dalla tua banca.',
            )}
          </p>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700">
          {pick('Which bank do you use? (e.g. Mercury, Wise, Chase, Revolut, Airwallex, Relay)', 'Qual è la tua banca? (es. Mercury, Wise, Chase, Revolut, Airwallex, Relay)')}
        </label>
        <input
          type="text"
          value={bank}
          onChange={e => { setBank(e.target.value); setFetched(null) }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); lookup() } }}
          placeholder={pick('Type your bank name…', 'Scrivi il nome della banca…')}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        {q.length >= 2 && !guide && (
          <div className="mt-2">
            <button
              type="button"
              onClick={lookup}
              disabled={loading}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {loading
                ? pick('Finding instructions…', 'Cerco le istruzioni…')
                : pick('Show me how to download the CSV', 'Mostra come scaricare il CSV')}
            </button>
          </div>
        )}
        {guide && (
          <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2.5">
            <p className="text-xs font-semibold text-emerald-900">
              {interpolateString(pick('How to download the CSV from {name}:', 'Come scaricare il CSV da {name}:'), { name: guide.name })}
            </p>
            <ol className="mt-1 list-decimal pl-4 space-y-0.5 text-xs leading-relaxed text-emerald-900/90">
              {gSteps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
            {gNote && <p className="mt-1.5 text-[11px] text-emerald-800/80">{gNote}</p>}
          </div>
        )}
      </div>

      <p className="text-xs text-gray-500">
        {pick(
          'Only have a PDF? Please still download the CSV from your bank — it’s the most reliable and fastest option. You’ll upload the files in the final step.',
          'Hai solo un PDF? Scarica comunque il CSV dalla tua banca: è il modo più affidabile e veloce. Caricherai i file nello step finale.',
        )}
      </p>

      {/* Required acknowledgement — gates the Next button (validateStep). */}
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border-2 border-amber-300 bg-white p-4 shadow-sm">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={e => onAcknowledge(e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded border-gray-400 text-amber-600 focus:ring-amber-500"
        />
        <span className="text-sm font-semibold text-amber-950">
          {pick(
            'I have read the above and I have downloaded all my bank statements for the full year.',
            'Ho letto quanto sopra e ho scaricato tutti i miei estratti conto bancari dell’intero anno.',
          )}
        </span>
      </label>
    </div>
  )
}

export function WizardClient({
  wizardType,
  entityType,
  entityUnresolved = false,
  prefillData,
  savedData,
  savedStep,
  progressId,
  accountId,
  contactId,
  leadId,
  locale,
  initialSubmitStatus,
  isLocked,
  itinCount = 0,
  bankGuides = [],
  institutions = [],
  configOverride,
}: WizardClientProps) {
  // Any language beyond en/it (dev job 12cab351) — see the identical
  // comment in wizard-field.tsx. Layered UNDER the existing it/en choice,
  // never replacing it: `translations` is only non-empty for a locale
  // outside SUPPORTED_LOCALES, and a field the exclusion registry kept out
  // of generation (lib/portal/translation-exclusions.ts) simply has
  // nothing here, so it safely falls through to it/en exactly as before.
  const { translations: fieldTranslations } = useLocale()
  const pickText = useCallback((en: string | undefined, it: string | undefined): string | undefined => {
    if (!en) return en
    return fieldTranslations[en] ?? (locale === 'it' && it ? it : en)
  }, [fieldTranslations, locale])
  // The client's answer to the one-owner/multi-owner question, when the server
  // could not resolve it. Seeded from saved data so a reload — or the autosave
  // round-trip — does not re-ask a question already answered.
  const [entityChoice, setEntityChoice] = useState<'SMLLC' | 'MMLLC' | null>(() => {
    const saved = savedData?.entity_type
    return saved === 'SMLLC' || saved === 'MMLLC' ? saved : null
  })
  // Everything downstream — the step list, the members repeater, the SS-4
  // signer rules, the submitted payload — reads THIS, never the raw prop.
  const effectiveEntityType = entityUnresolved ? (entityChoice ?? '') : entityType

  const { steps, fields: baseFields } = configOverride ?? getWizardConfig(wizardType, effectiveEntityType)

  // Inject the per-person "applies for ITIN?" field into the owner step and the
  // members step when the offer bundled ITIN (itinCount > 0). Done here (not in
  // the static config) so the question only appears for clients who bought ITIN.
  // dev_task fcf5e254.
  const fields = useMemo(() => {
    if (itinCount <= 0) return baseFields
    const f: Record<string, typeof baseFields[string]> = { ...baseFields }
    if (Array.isArray(f.owner)) f.owner = [...f.owner, OWNER_ITIN_FIELD]
    if (Array.isArray(f.members)) f.members = [...f.members, MEMBER_ITIN_FIELD]
    return f
  }, [baseFields, itinCount])

  // Merge prefill → saved → current (saved takes precedence over prefill, but only for non-empty values)
  // Empty saved values (from stale records saved before prefill fix) must NOT override prefill
  const filteredSaved = Object.fromEntries(
    Object.entries(savedData).filter(([, v]) => v !== '' && v !== null && v !== undefined)
  )
  const initialData = { ...prefillData, ...filteredSaved }

  const isResubmitMode = initialSubmitStatus === 'submitted' && !isLocked

  // Multi-member SS-4 Responsible Party (the signer) + members-ownership rules.
  // These belong ONLY to the wizards that render an owner + members roster
  // (formation, onboarding, tax) — see wizardCollectsOwnerMembers. Gating on a
  // bare MMLLC blocklist leaked the formation-only signer requirement into every
  // OTHER multi-member wizard that has no signer picker, deadlocking Submit: the
  // personal ITIN wizard demanded "Select exactly one SS-4 Responsible Party"
  // with no way to answer (Adam Mihaly / LUMA Beauty ITIN, 2026-07-24), and the
  // same trap sat latent on company_info and closure. Inert for SMLLC, ITIN,
  // banking, company_info, closure, and td_communication.
  const isMMLLC = effectiveEntityType === 'MMLLC' && wizardCollectsOwnerMembers(wizardType)
  // Narrower than isMMLLC: the SS-4 signer picker + its "exactly one" rule
  // belong only to the EIN-application wizards, not to tax. See
  // wizardRequiresSs4Signer for why tax was carrying it.
  const requiresSs4Signer = isMMLLC && wizardRequiresSs4Signer(wizardType)

  const [currentStep, setCurrentStep] = useState(Math.min(savedStep, steps.length - 1))
  const [formData, setFormData] = useState<Record<string, string | string[] | boolean | number>>(initialData)
  const [memberCount, setMemberCount] = useState(Number(initialData.member_count) || 1)

  // signerIndex: -1 = owner, 0+ = additional member index, null = none chosen.
  // Derived from any previously-saved is_signer flags so a resumed draft keeps
  // the selection. Saved JSONB may surface booleans as true or string 'true'.
  const isTruthyFlag = (v: unknown) => v === true || v === 'true'
  const [signerIndex, setSignerIndex] = useState<number | null>(() => {
    if (isTruthyFlag(initialData.owner_is_signer)) return -1
    for (const k of Object.keys(initialData)) {
      const m = k.match(/^member_(\d+)_is_signer$/)
      if (m && isTruthyFlag(initialData[k])) return parseInt(m[1], 10)
    }
    return null
  })

  // Select the signer: stamps the flat is_signer flags into formData so they are
  // saved/submitted with the rest of the wizard data (owner_is_signer +
  // member_{i}_is_signer). Exactly one ends up true.
  const setSigner = useCallback((index: number) => {
    setSignerIndex(index)
    setFormData(prev => {
      const next = { ...prev }
      next.owner_is_signer = index === -1
      for (let i = 0; i < memberCount; i++) next[`member_${i}_is_signer`] = index === i
      return next
    })
  }, [memberCount])
  // Track row counts for inline repeater fields (e.g., related_party_transactions)
  const [repeaterCounts, setRepeaterCounts] = useState<Record<string, number>>(() => {
    const counts: Record<string, number> = {}
    Object.entries(initialData).forEach(([key, value]) => {
      if (key.endsWith('_count') && key !== 'member_count' && !Number.isNaN(Number(value))) {
        counts[key.slice(0, -6)] = Number(value)
      }
    })
    return counts
  })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [currentProgressId, setCurrentProgressId] = useState(progressId)
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([])

  // Autosave machinery: every change funnels through handleFieldChange (typed
  // fields, repeater rows, uploaded file paths), so one dirty flag + one
  // debounced effect covers the whole wizard. Uploaded files are the precious
  // case — losing their reference on an unsaved reload orphans the file.
  const dirtyRef = useRef(false)
  const autosaveBusyRef = useRef(false)
  const [autosavedAt, setAutosavedAt] = useState<Date | null>(null)

  const handleFieldChange = useCallback((name: string, value: string | string[] | boolean | number) => {
    setFormData(prev => ({ ...prev, [name]: value }))
    dirtyRef.current = true
    // Clear any server-side validation error for this field when the user edits it
    setFieldErrors(prev => prev.length > 0 ? prev.filter(e => e.field !== name) : prev)
  }, [])

  // File upload handler — uploads the file DIRECTLY to Supabase Storage with a
  // RESUMABLE (TUS) upload: 6MB chunks, auto-retry on network blips, progress
  // reporting, no ~4.5MB serverless body cap. Returns the storage path, or null
  // on failure. dev_task 64bfcdd9.
  const handleFileUpload = useCallback(
    async (fieldName: string, file: File, onProgress?: (pct: number) => void): Promise<string | null> => {
      try {
        // Instant client-side check — no need to round-trip to the server for
        // something we already know. The server re-checks authoritatively
        // below (this check can be bypassed).
        if (file.size > WIZARD_UPLOAD_MAX_FILE_SIZE_BYTES) {
          const guided = new Error(wizardUploadTooLargeMessage(file.size)) as Error & { isUserMessage?: boolean }
          guided.isUserMessage = true
          throw guided
        }

        // 1. Ask the server to mint the storage path (it owns the path scheme).
        const res = await fetch('/api/portal/wizard-upload-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            field_name: fieldName,
            file_name: file.name,
            file_size: file.size,
            wizard_type: wizardType,
            // Prefer leadId so a new-company formation's uploads stay in their own
            // folder (not co-mingled with an existing account or contact).
            identifier: leadId || accountId || contactId || 'unknown',
          }),
        })
        if (!res.ok) {
          const errText = await res.text().catch(() => '')
          console.error('[wizard-upload] mint-path failed', { status: res.status, error: errText, fieldName, fileName: file.name, fileSize: file.size, fileType: file.type, wizardType })
          // R099: surface the server's guiding message (e.g. the CSV-only
          // explanation) to the client instead of a generic "Upload failed".
          // Marked so the outer catch below re-throws it instead of
          // swallowing it into a silent `null`.
          let serverError: string | null = null
          try {
            serverError = (JSON.parse(errText) as { error?: string })?.error ?? null
          } catch { /* not JSON */ }
          if (serverError) {
            const guided = new Error(serverError) as Error & { isUserMessage?: boolean }
            guided.isUserMessage = true
            throw guided
          }
          // Funnel into the catch below so the failure is error-audited too.
          throw new Error(`mint-path failed (HTTP ${res.status})`)
        }
        const { path } = await res.json()
        if (!path) return null

        // 2. Resumable upload straight to storage with the client's session token.
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session?.access_token) {
          console.error('[wizard-upload] no session token', { fieldName, fileName: file.name })
          return null
        }
        const { uploadResumable } = await import('@/lib/portal/resumable-upload')
        await uploadResumable({
          supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
          anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          accessToken: session.access_token,
          bucket: UPLOAD_BUCKET,
          path,
          file,
          onProgress,
        })
        return path as string
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[wizard-upload] upload failed', { error: msg, fieldName, fileName: file.name, fileSize: file.size, fileType: file.type, wizardType })
        // Guided server messages (R099) propagate to the field UI; anything
        // else stays a silent null → generic "Upload failed" fallback.
        if (err instanceof Error && (err as Error & { isUserMessage?: boolean }).isUserMessage) throw err
        // Fire-and-forget error-audit capture: an upload failure was only
        // visible in the CLIENT's browser console, so staff never saw why a
        // client reported "it won't upload my documents" (LT Program,
        // 2026-07-07). This lands it in system_errors for the 15-min AI
        // diagnosis cron.
        void fetch('/api/system-errors/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            route: 'portal-wizard-file-upload',
            method: 'POST',
            page_path: window.location.pathname,
            message: msg,
            context: { fieldName, fileName: file.name, fileSize: file.size, fileType: file.type, wizardType },
          }),
        }).catch(() => { /* reporting must never break the wizard */ })
        return null
      }
    },
    [wizardType, accountId, contactId, leadId],
  )

  // ✨ AI draft helper for TD Communication brand-audit textareas. POSTs the
  // client's own answers as context and returns a suggested draft; the WizardField
  // preview lets the client use/append it (never auto-written). R099: surface the
  // server's message. Wired only for wizardType === 'td_communication' below.
  const handleAiAssist = useCallback(
    async (field: FieldConfig, _currentValue: string): Promise<string | null> => {
      try {
        const res = await fetch('/api/td-communication/ai/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            questionKey: field.name,
            questionLabel: field.label,
            answers: formData,
            locale,
          }),
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error || pickText('Could not generate a draft.', 'Generazione non riuscita.'))
        }
        const data = await res.json()
        return typeof data.text === 'string' ? data.text : null
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : pickText('Could not generate a draft.', 'Generazione non riuscita.')!)
        return null
      }
    },
    [formData, locale, pickText],
  )

  // A file field is empty when its array of paths is empty. Other field types
  // keep the original string/boolean/number emptiness rules.
  const isEmptyValue = (val: unknown) => {
    if (val === undefined || val === null || val === false) return true
    if (Array.isArray(val)) return val.length === 0
    if (typeof val === 'string') return !val.trim()
    return false
  }


  // Validate current step
  // Clarify fix (2026-07-24): instead of a SILENT disabled "Next" button, we
  // collect WHICH required fields on the step are empty/invalid and WHY, keyed
  // by their real formData key, so the UI can highlight each one and explain it
  // in the client's language (Matteo / Luca's 5 MMLLC clients — they hit blank
  // required questions the old form never had and would otherwise stare at a
  // dead grey button). validateStep is derived from this (empty errors = valid),
  // so there is ONE source of truth for step completeness.
  const reqMsg = pickText('Required field', 'Campo obbligatorio')!
  const minMsg = pickText('Value is not valid', 'Il valore non è valido')!

  const getStepErrors = useCallback((): Record<string, string> => {
    const errs: Record<string, string> = {}
    const stepId = steps[currentStep].id
    const stepFields = fields[stepId] || []

    if (stepId === 'prepare') {
      if (formData['prepare_acknowledged'] !== true) {
        errs['prepare_acknowledged'] = pickText(
          'Confirm you have read the above and downloaded your statements to continue',
          'Conferma di aver letto e scaricato gli estratti conto per continuare',
        )!
      }
      return errs
    }

    if (stepId === 'members') {
      for (let idx = 0; idx < memberCount; idx++) {
        const rawType = formData[`member_${idx}_member_type`]
        const resolvedType = (rawType === undefined || rawType === null || rawType === '') ? 'individual' : String(rawType)
        for (const field of stepFields) {
          if (field.conditional) {
            const refValue = field.conditional.field === 'member_type'
              ? resolvedType
              : formData[`member_${idx}_${field.conditional.field}`]
            if (String(refValue) !== field.conditional.value) continue
          }
          const key = `member_${idx}_${field.name}`
          if (field.required && isEmptyValue(formData[key])) errs[key] = reqMsg
          else if (belowFieldMin(field, formData[key])) errs[key] = minMsg
        }
      }
      if (wizardType === 'tax' && isMMLLC) {
        let pctSum = 0
        for (let idx = 0; idx < memberCount; idx++) {
          const v = Number(formData[`member_${idx}_member_ownership_pct`])
          if (!Number.isNaN(v)) pctSum += v
        }
        if (Math.abs(pctSum - 100) > 0.5) {
          errs['__members_ownership'] = interpolateString(
            pickText('Ownership shares must total 100% (currently {pctSum}%)', 'Le quote dei soci devono sommare al 100% (ora: {pctSum}%)')!,
            { pctSum },
          )
        }
      }
      return errs
    }

    for (const field of stepFields) {
      if (!isFieldVisible(field, stepFields, formData)) continue
      if (field.type === 'repeater') {
        const count = repeaterCounts[field.name] ?? (Number(formData[`${field.name}_count`]) || 0)
        if ((field.required || field.repeaterRequired) && count < 1) {
          errs[field.name] = pickText('Add at least one entry', 'Aggiungi almeno una voce')!
        }
        for (let idx = 0; idx < count; idx++) {
          for (const rf of field.repeaterFields ?? []) {
            const key = `${field.name}_${idx}_${rf.name}`
            // Identity build (2026-08-13, card 4a39e0fd): the account number is
            // MODE-CONDITIONALLY required — a BANK (account_number mode per the
            // live registry) must carry it, because an unnumbered bank upload
            // is how one real account silently splits into two; Wise-style
            // services and crypto are never asked. The per-row escape
            // ("genuinely has no single number") waives it. Deliberately NOT a
            // static required flag — that would demand a number from Wise.
            const modeRequired =
              field.name === 'bank_accounts' && rf.name === 'account_label' &&
              String(formData[`${field.name}_${idx}_no_number`] ?? '') !== '1' &&
              resolveInstitution(
                String(formData[`${field.name}_${idx}_bank_name`] ?? ''),
                institutions.length ? institutions : undefined,
              ).mode === 'account_number' &&
              String(formData[`${field.name}_${idx}_bank_name`] ?? '').trim().length > 0
            if ((rf.required || modeRequired) && isEmptyValue(formData[key])) errs[key] = reqMsg
            else if (belowFieldMin(rf, formData[key])) errs[key] = minMsg
          }
        }
        continue
      }
      if (field.required && isEmptyValue(formData[field.name])) errs[field.name] = reqMsg
      else if (belowFieldMin(field, formData[field.name])) errs[field.name] = minMsg
    }
    return errs
  }, [currentStep, steps, fields, formData, memberCount, repeaterCounts, wizardType, isMMLLC, reqMsg, minMsg, institutions, pickText])

  const validateStep = useCallback(() => Object.keys(getStepErrors()).length === 0, [getStepErrors])

  // Resolve a flattened formData key to a human, localized field label so the
  // error list + the highlighted field read plainly (not `member_0_member_zip`).
  const labelForKey = useCallback((key: string): string => {
    if (key === '__members_ownership') return pickText('Member ownership', 'Quote dei soci')!
    const stepId = steps[currentStep].id
    const stepFields = fields[stepId] || []
    const pick = (f: FieldConfig) => pickText(f.label, f.labelIt) || f.name
    // member_{idx}_{name}
    const m = key.match(/^member_\d+_(.+)$/)
    if (m) {
      const f = TAX_MEMBER_FIELDS.find(ff => ff.name === m[1])
      if (f) return pick(f)
    }
    // {repeater}_{idx}_{sub}
    for (const f of stepFields) {
      if (f.type === 'repeater' && f.repeaterFields) {
        const rm = key.match(new RegExp(`^${f.name}_\\d+_(.+)$`))
        if (rm) {
          const rf = f.repeaterFields.find(ff => ff.name === rm[1])
          if (rf) return pick(rf)
        }
      }
    }
    const top = stepFields.find(f => f.name === key)
    if (top) return pick(top)
    return key
  }, [currentStep, steps, fields, pickText])

  // Compute the step's errors and PUBLISH them (highlight + summary). Returns
  // true when the step is BLOCKED (has errors). Used by forward navigation and
  // submit so the client sees exactly what to fix instead of a dead grey button.
  const raiseStepErrors = useCallback((): boolean => {
    const errs = getStepErrors()
    const keys = Object.keys(errs)
    if (keys.length === 0) { setFieldErrors([]); return false }
    setFieldErrors(keys.map(k => ({ field: k, message: errs[k] })))
    if (typeof document !== 'undefined') {
      const first = document.querySelector(`[data-field-key="${CSS.escape(keys[0])}"]`)
      if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' })
      else window.scrollTo({ top: 0, behavior: 'smooth' })
    }
    return true
  }, [getStepErrors])

  const errorFor = useCallback(
    (key: string) => fieldErrors.find(e => e.field === key)?.message,
    [fieldErrors],
  )

  // Save progress to wizard_progress table. `silent` = autosave mode: no
  // toasts (a failed autosave just stays dirty and retries on the next edit;
  // the manual Save draft button still reports loudly).
  const saveProgress = useCallback(async (silent: boolean): Promise<boolean> => {
    if (!silent) setIsSaving(true)
    try {
      const body = {
        wizard_type: wizardType,
        current_step: currentStep,
        data: formData,
        account_id: accountId || null,
        contact_id: contactId || null,
        lead_id: leadId || null,
        progress_id: currentProgressId,
      }

      const res = await fetch('/api/portal/wizard-progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (res.ok) {
        const result = await res.json()
        if (result.id) setCurrentProgressId(result.id)
        if (!silent) toast.success(pickText('Draft saved', 'Bozza salvata')!)
        return true
      }
      if (!silent) toast.error(pickText('Save failed', 'Errore nel salvataggio')!)
      return false
    } catch {
      if (!silent) toast.error(pickText('Save failed', 'Errore nel salvataggio')!)
      return false
    } finally {
      if (!silent) setIsSaving(false)
    }
  }, [wizardType, currentStep, formData, accountId, contactId, leadId, currentProgressId, pickText])

  const handleSave = useCallback(async () => {
    dirtyRef.current = false
    await saveProgress(false)
  }, [saveProgress])

  // Debounced autosave: 2.5s after the last change. saveProgress is recreated
  // on every formData change, so the effect re-arms — classic debounce. The
  // dirty flag stops no-op saves (initial mount, post-save idle); the busy ref
  // stops overlapping requests; a failed silent save re-marks dirty so the
  // next edit retries.
  useEffect(() => {
    if (!dirtyRef.current || isSubmitted || isSubmitting) return
    const t = setTimeout(async () => {
      if (autosaveBusyRef.current || isSubmitting || isSubmitted || !dirtyRef.current) return
      autosaveBusyRef.current = true
      dirtyRef.current = false
      const ok = await saveProgress(true)
      autosaveBusyRef.current = false
      if (ok) setAutosavedAt(new Date())
      else dirtyRef.current = true
    }, 2500)
    return () => clearTimeout(t)
  }, [saveProgress, isSubmitted, isSubmitting])

  // Submit wizard
  const handleSubmit = useCallback(async () => {
    // Clarify fix: highlight the exact missing fields on the final step + explain,
    // instead of a generic "fill all required fields" toast over a grey button.
    if (raiseStepErrors()) {
      toast.error(pickText('Complete the highlighted fields to submit', 'Completa i campi evidenziati per inviare')!)
      return
    }

    // ITIN: the offer dictates how many were purchased; the client must mark
    // exactly that many people as applicants. dev_task fcf5e254.
    if (itinCount > 0) {
      let chosen = formData.owner_needs_itin === 'Yes' ? 1 : 0
      for (let idx = 0; idx < memberCount; idx++) {
        if (formData[`member_${idx}_member_needs_itin`] === 'Yes') chosen++
      }
      if (chosen !== itinCount) {
        toast.error(
          interpolateString(
            pickText(
              'Select exactly {itinCount} person(s) to apply for the ITIN (you selected {chosen}).',
              "Seleziona esattamente {itinCount} persona/e che richiedono l'ITIN (selezionate: {chosen}).",
            )!,
            { itinCount, chosen },
          ),
        )
        return
      }
    }

    // MMLLC formation: validate exactly one signer chosen and that the
    // additional members' ownership sums to a sane share (the owner takes the
    // remainder, 100 − sum, at materialization). Gated to MMLLC so SMLLC and
    // every other wizard are untouched.
    if (isMMLLC) {
      // SS-4 Responsible Party — ONLY for the wizards that feed an EIN
      // application. Excluded from tax (2026-07-28): nothing in the tax
      // pipeline reads the signer, and by tax season the EIN already exists,
      // so this refused the whole questionnaire over a discarded answer. The
      // ownership-sum check below still runs for tax and is required there.
      if (requiresSs4Signer) {
        let signerCount = isTruthyFlag(formData.owner_is_signer) ? 1 : 0
        for (let i = 0; i < memberCount; i++) {
          if (isTruthyFlag(formData[`member_${i}_is_signer`])) signerCount++
        }
        if (signerCount !== 1) {
          toast.error(
            pickText(
              'Select exactly one person as the SS-4 Responsible Party.',
              'Seleziona esattamente una persona come Responsible Party del modulo SS-4.',
            )!,
          )
          return
        }
      }

      let pctSum = 0
      for (let i = 0; i < memberCount; i++) {
        const v = Number(formData[`member_${i}_member_ownership_pct`])
        if (!Number.isNaN(v)) pctSum += v
      }
      if (wizardType === 'tax') {
        // Tax MMLLC: the members list is the FULL roster — the person filling
        // the form is one of the members (no separate owner step). Every member
        // is on a K-1, so the shares must add up to exactly 100%. A 0.5 epsilon
        // absorbs thirds (33.33×3 = 99.99).
        if (Math.abs(pctSum - 100) > 0.5) {
          toast.error(
            interpolateString(
              pickText(
                "All members' ownership must total 100% (currently {pctSum}%). Remember to include yourself as a member.",
                'Le quote di tutti i soci devono fare 100% (attuale: {pctSum}%). Ricordati di includere anche te stesso tra i soci.',
              )!,
              { pctSum },
            ),
          )
          return
        }
      } else if (!(pctSum > 0 && pctSum < 100)) {
        // Formation MMLLC: separate owner step; additional members < 100%, the
        // owner takes the remaining share at materialization.
        toast.error(
          interpolateString(
            pickText(
              "Additional members' ownership must total more than 0% and less than 100% (currently {pctSum}%). The owner takes the remaining share.",
              'La somma delle quote dei membri aggiuntivi deve essere maggiore di 0% e minore di 100% (attuale: {pctSum}%). Il titolare riceve la quota rimanente.',
            )!,
            { pctSum },
          ),
        )
        return
      }
    }

    setIsSubmitting(true)
    setFieldErrors([])

    // The submit endpoint is IDEMPOTENT: it marks wizard_progress 'submitted'
    // before anything else, and a repeat call with the same progress_id returns
    // "already submitted" success WITHOUT re-enqueuing the job. So a transient
    // delivery failure — the server processed the submission and returned 200,
    // but the response never reached the browser — is safe to retry. Without
    // this, that lost response showed a hard "Submission failed", isSubmitted
    // stayed false, and the client was STRANDED with no path to the P&L /
    // Balance Sheet screen even though the submission had gone through
    // (Luca/Dynamiq, 2026-06-16). Retries cover network errors and 5xx; a real
    // validation error (400 + fields) is never retried.
    const MAX_ATTEMPTS = 3
    let lastError = ''
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch('/api/portal/wizard-submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            wizard_type: wizardType,
            // The client's answer when the server could not resolve it. This is
            // a HINT, not the final word: the submit route passes it through
            // verbatim, and it is formation MATERIALIZATION that re-resolves
            // from the signed contract and overrules this if they disagree.
            entity_type: effectiveEntityType,
            data: formData,
            account_id: accountId || null,
            contact_id: contactId || null,
            lead_id: leadId || null,
            progress_id: currentProgressId,
            // Attempt 1 carries the caller's flag; retries force the idempotent
            // dedup path (attempt 1 already marked it submitted), so a retry
            // confirms success rather than re-processing / duplicating the job.
            allow_resubmit: attempt === 1 ? (isResubmitMode || undefined) : false,
          }),
        })

        if (res.ok) {
          setIsSubmitting(false)
          setIsSubmitted(true)
          toast.success(pickText('Data submitted successfully!', 'Dati inviati con successo!')!)
          return
        }

        // Structured validation error ({ error, fields }) — a real client
        // problem, never retried.
        const err = await res.json().catch(() => ({} as { error?: string; fields?: FieldError[] }))
        if (res.status === 400 && Array.isArray(err?.fields) && err.fields.length > 0) {
          setFieldErrors(err.fields)
          const first = err.fields[0]
          toast.error(`${first.field}: ${first.message}`)
          setIsSubmitting(false)
          return
        }
        // 5xx / other non-ok → retryable.
        lastError = err?.error || ''
      } catch {
        lastError = '' // network / lost-response — retryable
      }
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 700 * attempt))
    }

    // All attempts failed. The data may have been saved server-side, so guide
    // the user to refresh instead of implying the work is lost.
    setIsSubmitting(false)
    toast.error(
      lastError ||
      pickText(
        "Submit didn't go through after a few tries. Refresh the page — if it shows as already submitted, it worked.",
        "Invio non riuscito dopo alcuni tentativi. Aggiorna la pagina: se risulta già inviato, è andato a buon fine.",
      )!,
    )
  }, [wizardType, effectiveEntityType, formData, accountId, contactId, leadId, currentProgressId, raiseStepErrors, isResubmitMode, itinCount, memberCount, isMMLLC, requiresSs4Signer, pickText])

  // Auto-save on step change
  const handleStepChange = useCallback((step: number) => {
    // Clarify fix: a FORWARD move must pass the current step. If it doesn't,
    // highlight the exact missing fields + explain, and stay put — never a
    // silent dead button. Backward moves (and tab clicks to earlier steps) are
    // always allowed and clear the errors.
    if (step > currentStep) {
      if (raiseStepErrors()) return
    } else {
      setFieldErrors([])
    }
    setCurrentStep(step)
    // Auto-save in background (only if user has entered data)
    const hasData = Object.keys(formData).some(k => formData[k] !== undefined && formData[k] !== '')
    if (hasData && (accountId || contactId || leadId)) {
      fetch('/api/portal/wizard-progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wizard_type: wizardType,
          current_step: step,
          data: formData,
          account_id: accountId || null,
          contact_id: contactId || null,
          lead_id: leadId || null,
          progress_id: currentProgressId,
        }),
      }).then(res => res.ok ? res.json() : null)
        .then(result => { if (result?.id) setCurrentProgressId(result.id) })
        .catch(() => {
          console.warn('[wizard] Auto-save failed — data preserved in memory')
        })
    }
  }, [wizardType, formData, accountId, contactId, leadId, currentProgressId, currentStep, raiseStepErrors])

  // ── One-owner / multi-owner question ──────────────────────────────────────
  // Only reached when the signed contract AND the offer both failed to say what
  // this company is. Antonio, 2026-08-09: ask the client rather than wall them —
  // "a hard stop recreates the dead end this whole job exists to fix, and it
  // would hit returning clients hardest." The answer shapes the FORM only; the
  // signed contract still governs what is recorded downstream.
  // Placed after every hook (React requires a stable hook order) and before the
  // locked/submitted screens, which cannot apply to a form not yet started.
  if (entityUnresolved && !entityChoice) {
    const choose = (code: 'SMLLC' | 'MMLLC') => {
      setEntityChoice(code)
      // Persisted only for a form still being filled. On an ALREADY-SUBMITTED
      // formation, routing the answer through handleFieldChange would mark the
      // form dirty and fire the autosave, rewriting a submitted record's saved
      // data (and re-populating fields the client deliberately left blank from
      // prefill) purely because a question was rendered. Local state is enough
      // there — the client's own edits will persist it if they actually edit.
      if (initialSubmitStatus !== 'submitted') {
        handleFieldChange('entity_type', code)
      }
    }
    return (
      <div className="max-w-lg mx-auto py-12">
        <h2 className="text-2xl font-bold mb-2 text-zinc-900">
          {pickText('One question before we start', 'Una domanda prima di iniziare')}
        </h2>
        <p className="text-sm text-zinc-600 mb-6">
          {pickText(
            'Who will own the new company? You can change this by talking to us at any time.',
            'Chi saranno i proprietari della nuova società? Puoi cambiare questa risposta parlando con noi in qualsiasi momento.',
          )}
        </p>
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => choose('SMLLC')}
            className="w-full text-left rounded-xl border border-zinc-200 bg-white p-4 hover:border-blue-500 hover:bg-blue-50 transition-colors"
          >
            <span className="block font-medium text-zinc-900">
              {pickText('Just me', 'Solo io')}
            </span>
            <span className="block text-xs text-zinc-500 mt-1">
              {pickText('A single owner', 'Un solo proprietario')}
            </span>
          </button>
          <button
            type="button"
            onClick={() => choose('MMLLC')}
            className="w-full text-left rounded-xl border border-zinc-200 bg-white p-4 hover:border-blue-500 hover:bg-blue-50 transition-colors"
          >
            <span className="block font-medium text-zinc-900">
              {pickText('Me and other owners', 'Io e altri soci')}
            </span>
            <span className="block text-xs text-zinc-500 mt-1">
              {pickText('You will add the other owners in the form', 'Potrai aggiungere gli altri soci nel modulo')}
            </span>
          </button>
        </div>
      </div>
    )
  }

  // Locked screen — the data has moved past the point where the client may
  // still change it themselves.
  //
  // The copy is per-wizard. It used to be hardcoded to the TAX wording, which
  // was fine while `isLocked` was computed for tax only — but a locked FORMATION
  // client was then told "Your tax information has been reviewed", which is
  // both wrong and dead-ends them (dev job ca788354, caught in sandbox
  // click-through). Formation clients are pointed at chat instead, per
  // Antonio's ruling: changes after we begin work go through us.
  if (isLocked) {
    const lockedCopy =
      wizardType === 'formation'
        ? {
            title: pickText('Your details are with us', 'Dati già inviati'),
            body: pickText(
              'We have started work on your company, so this form can no longer be edited. If something needs correcting, send us a message in chat and we will take care of it.',
              'Abbiamo iniziato a lavorare sulla tua società, quindi questo modulo non è più modificabile. Se qualcosa deve essere corretto, scrivicelo in chat e ce ne occupiamo noi.',
            ),
            cta: pickText('Message us in chat', 'Vai alla chat'),
            href: '/portal/chat',
          }
        : {
            title: pickText('Tax information reviewed', 'Informazioni fiscali in elaborazione'),
            body: pickText(
              'Your tax information has been reviewed and is being processed. No further action is required from you.',
              'Le tue informazioni fiscali sono state esaminate e sono in fase di elaborazione. Non sono necessarie ulteriori azioni da parte tua.',
            ),
            cta: pickText('Back to Dashboard', 'Torna alla Dashboard'),
            href: '/portal',
          }

    return (
      <div className="max-w-lg mx-auto text-center py-16">
        <div className="h-16 w-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <Lock className="h-8 w-8 text-blue-600" />
        </div>
        <h2 className="text-2xl font-bold mb-2">{lockedCopy.title}</h2>
        <p className="text-zinc-500 mb-6">{lockedCopy.body}</p>
        <a
          href={lockedCopy.href}
          className="inline-flex items-center px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          {lockedCopy.cta}
        </a>
      </div>
    )
  }

  // Success screen (shown after successful submit or re-submit)
  if (isSubmitted) {
    const isBanking = wizardType === 'banking_payset' || wizardType === 'banking_relay'
    const bankLabel = wizardType === 'banking_relay' ? 'Relay (USD)' : 'Payset (EUR)'
    // MMLLC/Corp tax: the submission's bank CSVs feed the generated P&L +
    // Balance Sheet — the success screen's PRIMARY action is checking them
    // (master plan §3.5; before this the screen never mentioned they exist).
    const isTaxFinancials = wizardType === 'tax' && (effectiveEntityType === 'MMLLC' || effectiveEntityType === 'Corp')

    return (
      <div className="max-w-lg mx-auto text-center py-16">
        <div className="h-16 w-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <CheckCircle className="h-8 w-8 text-green-600" />
        </div>
        <h2 className="text-2xl font-bold mb-2">
          {isBanking
            ? interpolateString(pickText('{bankLabel} — Application submitted!', '{bankLabel} — Richiesta inviata!')!, { bankLabel })
            : pickText('Data submitted successfully!', 'Dati inviati con successo!')}
        </h2>
        <p className="text-zinc-500 mb-6">
          {isTaxFinancials
            ? pickText(
                'We are preparing your Profit & Loss and Balance Sheet from the files you uploaded — check them, answer any remaining questions, and confirm the numbers.',
                'Stiamo preparando il tuo Conto Economico e Stato Patrimoniale dai file che hai caricato — controllali, rispondi alle eventuali domande e conferma i numeri.',
              )
            : pickText(
                'Our team will review your information and contact you shortly.',
                'Il nostro team esaminerà le informazioni e ti contatterà a breve.',
              )}
        </p>
        {isTaxFinancials ? (
          <div className="space-y-3">
            <a
              href="/portal/tax-financials"
              className="inline-flex items-center px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
            >
              {pickText('See your Profit & Loss and Balance Sheet →', 'Vedi il tuo Conto Economico e Stato Patrimoniale →')}
            </a>
            <div>
              <a
                href="/portal"
                className="inline-flex items-center px-4 py-1.5 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
              >
                {pickText('Back to Dashboard', 'Torna alla Dashboard')}
              </a>
            </div>
          </div>
        ) : isBanking ? (
          <div className="space-y-3">
            <a
              href="/portal/wizard?type=banking"
              className="inline-flex items-center px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
            >
              {pickText('Continue with other banks →', 'Continua con le altre banche →')}
            </a>
            <div>
              <a
                href="/portal"
                className="inline-flex items-center px-4 py-1.5 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
              >
                {pickText('Back to Dashboard', 'Torna alla Dashboard')}
              </a>
            </div>
          </div>
        ) : (
          <a
            href="/portal"
            className="inline-flex items-center px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            {pickText('Back to Dashboard', 'Torna alla Dashboard')}
          </a>
        )}
      </div>
    )
  }

  // Render current step fields
  const stepId = steps[currentStep].id
  const stepFields = fields[stepId] || []
  const isMembersStep = stepId === 'members'
  const isPrepareStep = stepId === 'prepare'

  return (
    <WizardShell
      steps={steps}
      currentStep={currentStep}
      onStepChange={handleStepChange}
      onSubmit={handleSubmit}
      onSave={handleSave}
      canProceed={validateStep()}
      isSubmitting={isSubmitting}
      isSaving={isSaving}
      locale={locale}
      submitLabel={isResubmitMode ? pickText('Re-submit', 'Aggiorna invio') : undefined}
      autosaveStatus={autosavedAt
        ? `${pickText('Saved', 'Salvato')} ${autosavedAt.toLocaleTimeString(locale === 'it' ? 'it-IT' : 'en-US', { hour: '2-digit', minute: '2-digit' })}`
        : null}
    >
      {/* Re-submit mode banner */}
      {isResubmitMode && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
          <Pencil className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-amber-900">
              {pickText('Already submitted — you can edit', 'Dati già inviati — puoi modificare')}
            </p>
            <p className="text-amber-700 mt-0.5">
              {pickText(
                "Your data has been submitted but not yet reviewed. You can update your answers until we begin the review.",
                "I tuoi dati sono stati inviati ma non ancora esaminati. Puoi aggiornare le risposte fino all'inizio della revisione.",
              )}
            </p>
          </div>
        </div>
      )}

      {/* Validation summary — client-side (missing required fields on this step,
          Clarify fix) OR server-side (wizard-submit 400). Lists each blocking
          field by its plain localized label + the reason, and each field is
          also highlighted below. */}
      {fieldErrors.length > 0 && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4 mb-4" data-testid="wizard-field-errors">
          <AlertCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
          <div className="text-sm w-full">
            <p className="font-semibold text-red-900 mb-1">
              {pickText('To continue, complete these fields:', 'Per continuare, completa questi campi:')}
            </p>
            <ul className="list-disc list-inside text-red-700 space-y-0.5">
              {fieldErrors.map((fe, i) => (
                <li key={`${fe.field}-${i}`}>
                  <span className="font-medium">{labelForKey(fe.field)}</span>: {fe.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {isPrepareStep ? (
        <PrepareCsvStep
          locale={locale}
          bankGuides={bankGuides}
          acknowledged={formData['prepare_acknowledged'] === true}
          onAcknowledge={v => handleFieldChange('prepare_acknowledged', v)}
        />
      ) : isMembersStep ? (
        /* Members repeater — add/remove members */
        <div className="space-y-6">
          {Array.from({ length: memberCount }).map((_, idx) => (
            <div key={idx} className="border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-zinc-700">
                  {interpolateString(pickText('Member {n}', 'Membro {n}')!, { n: idx + 1 })}
                </h3>
                {memberCount > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      const newCount = memberCount - 1
                      setMemberCount(newCount)
                      // Shift every later member down one slot, then clear the
                      // last index — otherwise removing a middle member leaves
                      // the following members' data orphaned above the count
                      // (and the tax submission would still read it as a member).
                      setFormData(prev => {
                        const next = { ...prev }
                        for (let i = idx; i < newCount; i++) {
                          stepFields.forEach(f => {
                            const from = next[`member_${i + 1}_${f.name}`]
                            if (from === undefined) delete next[`member_${i}_${f.name}`]
                            else next[`member_${i}_${f.name}`] = from
                          })
                        }
                        stepFields.forEach(f => { delete next[`member_${newCount}_${f.name}`] })
                        // Clear the now-orphaned signer flag above the new count
                        // so a stale member_{i}_is_signer key isn't submitted.
                        delete next[`member_${newCount}_is_signer`]
                        next.member_count = newCount
                        return next
                      })
                      // If the removed member was the signer, clear the selection
                      // so submit forces a fresh, valid choice.
                      if (signerIndex === idx) setSignerIndex(null)
                    }}
                    className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1"
                  >
                    <Trash2 className="h-3 w-3" /> {pickText('Remove', 'Rimuovi')}
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {stepFields
                  .filter(field => {
                    if (!field.conditional) return true
                    // Evaluate conditional relative to this member's own member_type field.
                    // Default to 'individual' when unset so individual fields show on first render.
                    const memberTypeKey = `member_${idx}_${field.conditional.field}`
                    const memberTypeVal = formData[memberTypeKey]
                    const resolved = (memberTypeVal === undefined || memberTypeVal === null || memberTypeVal === '')
                      ? 'individual'
                      : String(memberTypeVal)
                    return resolved === field.conditional.value
                  })
                  .map(field => (
                    <div key={`${idx}_${field.name}`} data-field-key={`member_${idx}_${field.name}`} className={field.type === 'select' || field.type === 'textarea' || field.type === 'file' ? 'md:col-span-2' : ''}>
                      <WizardField
                        field={field}
                        value={formData[`member_${idx}_${field.name}`] ?? ''}
                        onChange={(name, value) => handleFieldChange(`member_${idx}_${name}`, value)}
                        onFileUpload={(name, file, onProgress) => handleFileUpload(`member_${idx}_${name}`, file, onProgress)}
                        locale={locale}
                        error={errorFor(`member_${idx}_${field.name}`)}
                      />
                    </div>
                  ))}
              </div>
              {/* MMLLC: this member can be the SS-4 Responsible Party. Hidden
                  on tax — the EIN already exists by then and nothing in the tax
                  pipeline reads the answer, so leaving the control would be a
                  dead tick box (2026-07-28). */}
              {requiresSs4Signer && (
                <SignerRadio
                  checked={signerIndex === idx}
                  onSelect={() => setSigner(idx)}
                  label={interpolateString(pickText('Member {n} is the SS-4 Responsible Party.', 'Membro {n} è il Responsible Party del modulo SS-4.')!, { n: idx + 1 })}
                />
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => {
              setMemberCount(c => c + 1)
              handleFieldChange('member_count', memberCount + 1)
              // Pre-set new member type to individual so individual fields show immediately
              handleFieldChange(`member_${memberCount}_member_type`, 'individual')
            }}
            className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 font-medium"
          >
            <Plus className="h-4 w-4" />
            {pickText('Add member', 'Aggiungi membro')}
          </button>

          {/* Live ownership total — tax MMLLC requires every member (including
              the person filling the form) to total exactly 100%. */}
          {wizardType === 'tax' && (() => {
            let pctSum = 0
            for (let i = 0; i < memberCount; i++) {
              const v = Number(formData[`member_${i}_member_ownership_pct`])
              if (!Number.isNaN(v)) pctSum += v
            }
            const ok = Math.abs(pctSum - 100) <= 0.5
            return (
              <div className={`rounded-lg border px-3 py-2.5 text-sm font-medium ${ok ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-amber-300 bg-amber-50 text-amber-900'}`}>
                {ok
                  ? interpolateString(pickText('✓ Total ownership: {pctSum}%', '✓ Quote totali: {pctSum}%')!, { pctSum })
                  : interpolateString(
                      pickText(
                        'Total ownership: {pctSum}% — must equal 100%. Include every member, including yourself.',
                        'Quote totali: {pctSum}% — devono fare 100%. Includi tutti i soci, te compreso.',
                      )!,
                      { pctSum },
                    )}
              </div>
            )
          })()}
        </div>
      ) : (
        <>
        {/* MMLLC: owner can elect to be the SS-4 Responsible Party. */}
        {requiresSs4Signer && stepId === 'owner' && (
          <div className="mb-4">
            <p className="text-sm font-semibold text-zinc-700 mb-1.5">
              {pickText('SS-4 Responsible Party', 'Responsible Party (SS-4)')}
            </p>
            <SignerRadio
              checked={signerIndex === -1}
              onSelect={() => setSigner(-1)}
              label={pickText('I will be the SS-4 Responsible Party.', 'Sarò io il Responsible Party del modulo SS-4.')!}
              hint={pickText(
                'Exactly one person across the owner and members must be selected.',
                'Una sola persona tra titolare e membri può essere selezionata.',
              )}
            />
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {stepFields
            .filter(field => {
              // Conditional show/hide applies to ALL field types, including
              // repeaters — e.g. related_party_transactions is gated behind the
              // has_related_party_transactions = 'Yes' answer. Visibility walks
              // the FULL ancestor chain (see isFieldVisible) so a stale child
              // answer can't keep a field on screen after its grandparent
              // flipped to No.
              return isFieldVisible(field, stepFields, formData)
            })
            .map(field => {
              // ── Inline repeater ─────────────────────────────────────
              if (field.type === 'repeater') {
                const count = repeaterCounts[field.name] ?? 0
                const addLabel = pickText(field.repeaterAddLabel ?? 'Add', field.repeaterAddLabelIt)
                return (
                  <div key={field.name} className="md:col-span-2 space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-700">{pickText(field.label, field.labelIt)}</span>
                      {(field.required || field.repeaterRequired)
                        ? <span className="text-xs font-semibold text-red-500">{pickText('(required)', '(obbligatorio)')}</span>
                        : <span className="text-xs text-zinc-400">{pickText('(optional)', '(opzionale)')}</span>}
                    </div>
                    {pickText(field.hint, field.hintIt) && (
                      <p className="text-xs text-zinc-500 leading-relaxed whitespace-pre-line">{pickText(field.hint, field.hintIt)}</p>
                    )}
                    {count === 0 && (
                      <p className={`text-xs italic ${(field.required || field.repeaterRequired) ? 'text-red-500' : 'text-zinc-400'}`}>
                        {(field.required || field.repeaterRequired)
                          ? pickText('Add at least one entry to continue.', 'Aggiungi almeno una voce per continuare.')
                          : pickText('No entries added yet.', 'Nessuna voce aggiunta.')}
                      </p>
                    )}
                    {Array.from({ length: count }).map((_, idx) => (
                      <div key={idx} className="border border-zinc-200 rounded-lg p-4 space-y-3 bg-zinc-50/50">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-zinc-500">#{idx + 1}</span>
                          <button
                            type="button"
                            onClick={() => {
                              const newCount = count - 1
                              setRepeaterCounts(prev => ({ ...prev, [field.name]: newCount }))
                              handleFieldChange(`${field.name}_count`, newCount)
                              setFormData(prev => {
                                // Shift every row ABOVE the removed one down a
                                // slot, then drop the last row's keys. Without
                                // the reindex, removing row 0 of 2 orphaned row
                                // 1's data under keys the renderer never reads
                                // (the orphan-upload-paths hazard, master plan §9).
                                const next = { ...prev }
                                // AD-HOC row keys shift too (bug-hunter,
                                // 2026-08-13): `no_number` (the bank-row
                                // "no single account number" escape) is not a
                                // repeaterField, so the old shift left a stale
                                // waiver at the removed index — silently
                                // waiving whatever bank slid into that slot,
                                // and pre-waiving the next row added there.
                                const subKeys = [...(field.repeaterFields?.map(rf => rf.name) ?? []), 'no_number']
                                for (let j = idx; j < newCount; j++) {
                                  subKeys.forEach(sub => {
                                    const from = `${field.name}_${j + 1}_${sub}`
                                    const to = `${field.name}_${j}_${sub}`
                                    if (from in next) next[to] = next[from]
                                    else delete next[to]
                                  })
                                }
                                subKeys.forEach(sub => { delete next[`${field.name}_${newCount}_${sub}`] })
                                return next
                              })
                            }}
                            className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1"
                          >
                            <Trash2 className="h-3 w-3" /> {pickText('Remove', 'Rimuovi')}
                          </button>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {field.repeaterFields?.map(rf => (
                            <div key={rf.name} data-field-key={`${field.name}_${idx}_${rf.name}`} className={rf.type === 'textarea' || rf.type === 'file' ? 'md:col-span-2' : ''}>
                              <WizardField
                                field={rf}
                                value={formData[`${field.name}_${idx}_${rf.name}`] ?? ''}
                                onChange={(name, value) => handleFieldChange(`${field.name}_${idx}_${name}`, value)}
                                error={errorFor(`${field.name}_${idx}_${rf.name}`)}
                                // Without the upload callback a file sub-field
                                // silently stores raw FILENAMES instead of
                                // storage paths (wizard-field.tsx fallback) —
                                // the third variant of the silent-file-loss bug
                                // class. The flattened name keeps the storage
                                // path scheme per-row unique.
                                onFileUpload={(name, file, onProgress) =>
                                  handleFileUpload(`${field.name}_${idx}_${name}`, file, onProgress)}
                                locale={locale}
                              />
                            </div>
                          ))}
                        </div>
                        {/* Identity build (2026-08-13): when the typed bank is
                            an account_number-mode institution, say WHY the
                            number matters (bilingual, red) and offer the
                            escape for services with no single number. The
                            requiredness itself is enforced in getStepErrors +
                            server-side at submit. */}
                        {field.name === 'bank_accounts' && (() => {
                          const typed = String(formData[`${field.name}_${idx}_bank_name`] ?? '')
                          if (typed.trim().length === 0) return null
                          const inst = resolveInstitution(typed, institutions.length ? institutions : undefined)
                          if (inst.mode !== 'account_number') return null
                          const noNumKey = `${field.name}_${idx}_no_number`
                          const waived = String(formData[noNumKey] ?? '') === '1'
                          return (
                            <div className="space-y-1.5">
                              {!waived && (
                                <div className="rounded-md border border-red-300 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700">
                                  {pickText(
                                    "⚠️ Double-check the account number after you type it — if it's wrong, your P&L will be wrong.",
                                    '⚠️ Ricontrolla il numero di conto dopo averlo scritto — se è sbagliato, il tuo P&L sarà sbagliato.',
                                  )}
                                </div>
                              )}
                              <label className="flex items-center gap-1.5 text-xs text-zinc-500">
                                <input
                                  type="checkbox"
                                  checked={waived}
                                  onChange={e => handleFieldChange(noNumKey, e.target.checked ? '1' : '')}
                                />
                                {pickText(
                                  'This is a multi-currency service or crypto (no single account number)',
                                  'È un servizio multivaluta o crypto (senza numero di conto unico)',
                                )}
                              </label>
                            </div>
                          )
                        })()}
                        {/* Bank CSV-export guide (catalog-driven): appears when
                            the typed bank name matches a guide — step-by-step
                            download help right under this bank's upload. */}
                        {(() => {
                          const typedBank = String(formData[`${field.name}_${idx}_bank_name`] ?? '').toLowerCase().trim()
                          if (typedBank.length < 3) return null
                          const guide = bankGuides.find(g => g.matchTerms.some(t => typedBank.includes(t)))
                          if (!guide) return null
                          const steps = locale === 'it' && guide.stepsIt.length > 0 ? guide.stepsIt : guide.stepsEn
                          const note = locale === 'it' && guide.noteIt ? guide.noteIt : guide.noteEn
                          return (
                            <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2.5">
                              <p className="text-xs font-semibold text-emerald-900">
                                {interpolateString(pickText('How to download the CSV from {name}:', 'Come scaricare il CSV da {name}:')!, { name: guide.name })}
                              </p>
                              <ol className="mt-1 list-decimal pl-4 space-y-0.5 text-xs leading-relaxed text-emerald-900/90">
                                {steps.map((s, i) => <li key={i}>{s}</li>)}
                              </ol>
                              {note && <p className="mt-1.5 text-[11px] text-emerald-800/80">{note}</p>}
                            </div>
                          )
                        })()}
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        const newCount = count + 1
                        setRepeaterCounts(prev => ({ ...prev, [field.name]: newCount }))
                        handleFieldChange(`${field.name}_count`, newCount)
                      }}
                      className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 font-medium"
                    >
                      <Plus className="h-4 w-4" />
                      {addLabel}
                    </button>
                  </div>
                )
              }
              // ── Regular field ────────────────────────────────────────
              return (
                <div key={field.name} data-field-key={field.name} className={field.type === 'textarea' || field.type === 'checkbox' ? 'md:col-span-2' : ''}>
                  <WizardField
                    field={{ ...field, prefilled: !!prefillData[field.name] }}
                    value={formData[field.name] ?? ''}
                    onChange={handleFieldChange}
                    onFileUpload={handleFileUpload}
                    onAiAssist={wizardType === 'td_communication' ? handleAiAssist : undefined}
                    locale={locale}
                    error={errorFor(field.name)}
                  />
                  {/* High-stakes confirmation: show an amber warning when the
                      field's value matches its configured warningOnValue (e.g.
                      a "No" to the related-party question → $25k IRS penalty). */}
                  {field.warningOnValue && String(formData[field.name] ?? '') === field.warningOnValue.value && (
                    <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2 text-xs text-amber-800 leading-relaxed">
                      <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                      <span>{pickText(field.warningOnValue.text, field.warningOnValue.textIt)}</span>
                    </div>
                  )}
                </div>
              )
            })}
        </div>
        </>
      )}
    </WizardShell>
  )
}
