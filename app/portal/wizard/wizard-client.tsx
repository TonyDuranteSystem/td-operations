'use client'

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { toast } from 'sonner'
import { WizardShell } from '@/components/portal/wizard/wizard-shell'
import { WizardField, type FieldConfig } from '@/components/portal/wizard/wizard-field'
import { getWizardConfig, OWNER_ITIN_FIELD, MEMBER_ITIN_FIELD } from '@/components/portal/wizard/wizard-configs'
import { createClient } from '@/lib/supabase/client'
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

export function WizardClient({
  wizardType,
  entityType,
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
}: WizardClientProps) {
  const { steps, fields: baseFields } = getWizardConfig(wizardType, entityType)

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

  // MMLLC formation only: who is the SS-4 Responsible Party (the signer).
  // Exactly one of {owner, each additional member} must be selected. This block
  // is inert for SMLLC and for non-formation wizards (the members step + owner
  // signer radio only render when isMMLLC).
  const isMMLLC = entityType === 'MMLLC'

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
        // 1. Ask the server to mint the storage path (it owns the path scheme).
        const res = await fetch('/api/portal/wizard-upload-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            field_name: fieldName,
            file_name: file.name,
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
          return null
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
        return null
      }
    },
    [wizardType, accountId, contactId, leadId],
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
  const validateStep = useCallback(() => {
    const stepId = steps[currentStep].id
    const stepFields = fields[stepId] || []

    // Members step: every field lives under an indexed key (member_{idx}_{name}),
    // so validate each of the memberCount members against the indexed keys.
    // The generic loop below checks bare field.name keys (which are always empty
    // here) and would wrongly block the step — that bug only surfaced once the
    // MMLLC members step started rendering.
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
          if (field.required && isEmptyValue(formData[`member_${idx}_${field.name}`])) return false
        }
      }
      return true
    }

    for (const field of stepFields) {
      // Skip validation for hidden conditional fields (applies to repeaters
      // too — e.g. the related-party repeater only when its gate is "Yes").
      // Full ancestor-chain check: a stale child answer must not keep a
      // field required after its grandparent flipped.
      if (!isFieldVisible(field, stepFields, formData)) continue
      // Repeater gate (merged from both wizard features 2026-06-11): a
      // required repeater (`required` — SMLLC related-party — OR
      // `repeaterRequired` — MMLLC bank accounts) needs ≥1 row, and every
      // row must fill its required sub-fields (mirrors the members logic).
      if (field.type === 'repeater') {
        const count = repeaterCounts[field.name] ?? (Number(formData[`${field.name}_count`]) || 0)
        if ((field.required || field.repeaterRequired) && count < 1) return false
        for (let idx = 0; idx < count; idx++) {
          for (const rf of field.repeaterFields ?? []) {
            if (rf.required && isEmptyValue(formData[`${field.name}_${idx}_${rf.name}`])) return false
          }
        }
        continue
      }
      if (field.required && isEmptyValue(formData[field.name])) return false
    }
    return true
  }, [currentStep, steps, fields, formData, memberCount, repeaterCounts])

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
        if (!silent) toast.success(locale === 'it' ? 'Bozza salvata' : 'Draft saved')
        return true
      }
      if (!silent) toast.error(locale === 'it' ? 'Errore nel salvataggio' : 'Save failed')
      return false
    } catch {
      if (!silent) toast.error(locale === 'it' ? 'Errore nel salvataggio' : 'Save failed')
      return false
    } finally {
      if (!silent) setIsSaving(false)
    }
  }, [wizardType, currentStep, formData, accountId, contactId, leadId, currentProgressId, locale])

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
    if (!validateStep()) {
      toast.error(locale === 'it' ? 'Compila tutti i campi obbligatori' : 'Please fill all required fields')
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
          locale === 'it'
            ? `Seleziona esattamente ${itinCount} persona/e che richiedono l'ITIN (selezionate: ${chosen}).`
            : `Select exactly ${itinCount} person(s) to apply for the ITIN (you selected ${chosen}).`,
        )
        return
      }
    }

    // MMLLC formation: validate exactly one signer chosen and that the
    // additional members' ownership sums to a sane share (the owner takes the
    // remainder, 100 − sum, at materialization). Gated to MMLLC so SMLLC and
    // every other wizard are untouched.
    if (isMMLLC) {
      let signerCount = isTruthyFlag(formData.owner_is_signer) ? 1 : 0
      for (let i = 0; i < memberCount; i++) {
        if (isTruthyFlag(formData[`member_${i}_is_signer`])) signerCount++
      }
      if (signerCount !== 1) {
        toast.error(
          locale === 'it'
            ? 'Seleziona esattamente una persona come Responsible Party del modulo SS-4.'
            : 'Select exactly one person as the SS-4 Responsible Party.',
        )
        return
      }

      let pctSum = 0
      for (let i = 0; i < memberCount; i++) {
        const v = Number(formData[`member_${i}_member_ownership_pct`])
        if (!Number.isNaN(v)) pctSum += v
      }
      if (!(pctSum > 0 && pctSum < 100)) {
        toast.error(
          locale === 'it'
            ? `La somma delle quote dei membri aggiuntivi deve essere maggiore di 0% e minore di 100% (attuale: ${pctSum}%). Il titolare riceve la quota rimanente.`
            : `Additional members' ownership must total more than 0% and less than 100% (currently ${pctSum}%). The owner takes the remaining share.`,
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
            entity_type: entityType,
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
          toast.success(locale === 'it' ? 'Dati inviati con successo!' : 'Data submitted successfully!')
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
      (locale === 'it'
        ? "Invio non riuscito dopo alcuni tentativi. Aggiorna la pagina: se risulta già inviato, è andato a buon fine."
        : "Submit didn't go through after a few tries. Refresh the page — if it shows as already submitted, it worked."),
    )
  }, [wizardType, entityType, formData, accountId, contactId, leadId, currentProgressId, validateStep, locale, isResubmitMode, itinCount, memberCount, isMMLLC])

  // Auto-save on step change
  const handleStepChange = useCallback((step: number) => {
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
  }, [wizardType, formData, accountId, contactId, leadId, currentProgressId])

  // Locked screen — Antonio has reviewed the data, no more editing
  if (isLocked) {
    return (
      <div className="max-w-lg mx-auto text-center py-16">
        <div className="h-16 w-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <Lock className="h-8 w-8 text-blue-600" />
        </div>
        <h2 className="text-2xl font-bold mb-2">
          {locale === 'it' ? 'Informazioni fiscali in elaborazione' : 'Tax information reviewed'}
        </h2>
        <p className="text-zinc-500 mb-6">
          {locale === 'it'
            ? 'Le tue informazioni fiscali sono state esaminate e sono in fase di elaborazione. Non sono necessarie ulteriori azioni da parte tua.'
            : 'Your tax information has been reviewed and is being processed. No further action is required from you.'}
        </p>
        <a
          href="/portal"
          className="inline-flex items-center px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          {locale === 'it' ? 'Torna alla Dashboard' : 'Back to Dashboard'}
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
    const isTaxFinancials = wizardType === 'tax' && (entityType === 'MMLLC' || entityType === 'Corp')

    return (
      <div className="max-w-lg mx-auto text-center py-16">
        <div className="h-16 w-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <CheckCircle className="h-8 w-8 text-green-600" />
        </div>
        <h2 className="text-2xl font-bold mb-2">
          {isBanking
            ? (locale === 'it' ? `${bankLabel} — Richiesta inviata!` : `${bankLabel} — Application submitted!`)
            : (locale === 'it' ? 'Dati inviati con successo!' : 'Data submitted successfully!')}
        </h2>
        <p className="text-zinc-500 mb-6">
          {isTaxFinancials
            ? (locale === 'it'
              ? 'Stiamo preparando il tuo Conto Economico e Stato Patrimoniale dai file che hai caricato — controllali, rispondi alle eventuali domande e conferma i numeri.'
              : 'We are preparing your Profit & Loss and Balance Sheet from the files you uploaded — check them, answer any remaining questions, and confirm the numbers.')
            : (locale === 'it'
              ? 'Il nostro team esaminerà le informazioni e ti contatterà a breve.'
              : 'Our team will review your information and contact you shortly.')}
        </p>
        {isTaxFinancials ? (
          <div className="space-y-3">
            <a
              href="/portal/tax-financials"
              className="inline-flex items-center px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
            >
              {locale === 'it' ? 'Vedi il tuo Conto Economico e Stato Patrimoniale →' : 'See your Profit & Loss and Balance Sheet →'}
            </a>
            <div>
              <a
                href="/portal"
                className="inline-flex items-center px-4 py-1.5 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
              >
                {locale === 'it' ? 'Torna alla Dashboard' : 'Back to Dashboard'}
              </a>
            </div>
          </div>
        ) : isBanking ? (
          <div className="space-y-3">
            <a
              href="/portal/wizard?type=banking"
              className="inline-flex items-center px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
            >
              {locale === 'it' ? 'Continua con le altre banche →' : 'Continue with other banks →'}
            </a>
            <div>
              <a
                href="/portal"
                className="inline-flex items-center px-4 py-1.5 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
              >
                {locale === 'it' ? 'Torna alla Dashboard' : 'Back to Dashboard'}
              </a>
            </div>
          </div>
        ) : (
          <a
            href="/portal"
            className="inline-flex items-center px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            {locale === 'it' ? 'Torna alla Dashboard' : 'Back to Dashboard'}
          </a>
        )}
      </div>
    )
  }

  // Render current step fields
  const stepId = steps[currentStep].id
  const stepFields = fields[stepId] || []
  const isMembersStep = stepId === 'members'

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
      submitLabel={isResubmitMode ? (locale === 'it' ? 'Aggiorna invio' : 'Re-submit') : undefined}
      autosaveStatus={autosavedAt
        ? `${locale === 'it' ? 'Salvato' : 'Saved'} ${autosavedAt.toLocaleTimeString(locale === 'it' ? 'it-IT' : 'en-US', { hour: '2-digit', minute: '2-digit' })}`
        : null}
    >
      {/* Re-submit mode banner */}
      {isResubmitMode && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
          <Pencil className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-amber-900">
              {locale === 'it' ? 'Dati già inviati — puoi modificare' : 'Already submitted — you can edit'}
            </p>
            <p className="text-amber-700 mt-0.5">
              {locale === 'it'
                ? 'I tuoi dati sono stati inviati ma non ancora esaminati. Puoi aggiornare le risposte fino all\'inizio della revisione.'
                : "Your data has been submitted but not yet reviewed. You can update your answers until we begin the review."}
            </p>
          </div>
        </div>
      )}

      {/* Server-side validation error banner — populated from /api/portal/wizard-submit 400 response */}
      {fieldErrors.length > 0 && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4 mb-4" data-testid="wizard-field-errors">
          <AlertCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
          <div className="text-sm w-full">
            <p className="font-semibold text-red-900 mb-1">
              {locale === 'it' ? 'Correggi i seguenti campi:' : 'Please correct the following:'}
            </p>
            <ul className="list-disc list-inside text-red-700 space-y-0.5">
              {fieldErrors.map((fe, i) => (
                <li key={`${fe.field}-${i}`}>
                  <span className="font-medium">{fe.field}</span>: {fe.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {isMembersStep ? (
        /* Members repeater — add/remove members */
        <div className="space-y-6">
          {Array.from({ length: memberCount }).map((_, idx) => (
            <div key={idx} className="border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-zinc-700">
                  {locale === 'it' ? `Membro ${idx + 1}` : `Member ${idx + 1}`}
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
                    <Trash2 className="h-3 w-3" /> {locale === 'it' ? 'Rimuovi' : 'Remove'}
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
                    <div key={`${idx}_${field.name}`} className={field.type === 'select' || field.type === 'textarea' || field.type === 'file' ? 'md:col-span-2' : ''}>
                      <WizardField
                        field={field}
                        value={formData[`member_${idx}_${field.name}`] ?? ''}
                        onChange={(name, value) => handleFieldChange(`member_${idx}_${name}`, value)}
                        onFileUpload={(name, file, onProgress) => handleFileUpload(`member_${idx}_${name}`, file, onProgress)}
                        locale={locale}
                      />
                    </div>
                  ))}
              </div>
              {/* MMLLC: this member can be the SS-4 Responsible Party. */}
              <SignerRadio
                checked={signerIndex === idx}
                onSelect={() => setSigner(idx)}
                label={locale === 'it'
                  ? `${idx === 0 ? `Membro ${idx + 1}` : `Membro ${idx + 1}`} è il Responsible Party del modulo SS-4.`
                  : `Member ${idx + 1} is the SS-4 Responsible Party.`}
              />
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
            {locale === 'it' ? 'Aggiungi membro' : 'Add member'}
          </button>
        </div>
      ) : (
        <>
        {/* MMLLC: owner can elect to be the SS-4 Responsible Party. */}
        {isMMLLC && stepId === 'owner' && (
          <div className="mb-4">
            <p className="text-sm font-semibold text-zinc-700 mb-1.5">
              {locale === 'it' ? 'Responsible Party (SS-4)' : 'SS-4 Responsible Party'}
            </p>
            <SignerRadio
              checked={signerIndex === -1}
              onSelect={() => setSigner(-1)}
              label={locale === 'it' ? 'Sarò io il Responsible Party del modulo SS-4.' : 'I will be the SS-4 Responsible Party.'}
              hint={locale === 'it'
                ? 'Una sola persona tra titolare e membri può essere selezionata.'
                : 'Exactly one person across the owner and members must be selected.'}
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
                const addLabel = locale === 'it' && field.repeaterAddLabelIt ? field.repeaterAddLabelIt : (field.repeaterAddLabel ?? 'Add')
                return (
                  <div key={field.name} className="md:col-span-2 space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-700">{locale === 'it' && field.labelIt ? field.labelIt : field.label}</span>
                      {(field.required || field.repeaterRequired)
                        ? <span className="text-xs font-semibold text-red-500">{locale === 'it' ? '(obbligatorio)' : '(required)'}</span>
                        : <span className="text-xs text-zinc-400">{locale === 'it' ? '(opzionale)' : '(optional)'}</span>}
                    </div>
                    {(locale === 'it' && field.hintIt ? field.hintIt : field.hint) && (
                      <p className="text-xs text-zinc-500 leading-relaxed whitespace-pre-line">{locale === 'it' && field.hintIt ? field.hintIt : field.hint}</p>
                    )}
                    {count === 0 && (
                      <p className={`text-xs italic ${(field.required || field.repeaterRequired) ? 'text-red-500' : 'text-zinc-400'}`}>
                        {(field.required || field.repeaterRequired)
                          ? (locale === 'it' ? 'Aggiungi almeno una voce per continuare.' : 'Add at least one entry to continue.')
                          : (locale === 'it' ? 'Nessuna voce aggiunta.' : 'No entries added yet.')}
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
                                for (let j = idx; j < newCount; j++) {
                                  field.repeaterFields?.forEach(rf => {
                                    const from = `${field.name}_${j + 1}_${rf.name}`
                                    const to = `${field.name}_${j}_${rf.name}`
                                    if (from in next) next[to] = next[from]
                                    else delete next[to]
                                  })
                                }
                                field.repeaterFields?.forEach(rf => { delete next[`${field.name}_${newCount}_${rf.name}`] })
                                return next
                              })
                            }}
                            className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1"
                          >
                            <Trash2 className="h-3 w-3" /> {locale === 'it' ? 'Rimuovi' : 'Remove'}
                          </button>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {field.repeaterFields?.map(rf => (
                            <div key={rf.name} className={rf.type === 'textarea' || rf.type === 'file' ? 'md:col-span-2' : ''}>
                              <WizardField
                                field={rf}
                                value={formData[`${field.name}_${idx}_${rf.name}`] ?? ''}
                                onChange={(name, value) => handleFieldChange(`${field.name}_${idx}_${name}`, value)}
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
                                {locale === 'it' ? `Come scaricare il CSV da ${guide.name}:` : `How to download the CSV from ${guide.name}:`}
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
                <div key={field.name} className={field.type === 'textarea' || field.type === 'checkbox' ? 'md:col-span-2' : ''}>
                  <WizardField
                    field={{ ...field, prefilled: !!prefillData[field.name] }}
                    value={formData[field.name] ?? ''}
                    onChange={handleFieldChange}
                    onFileUpload={handleFileUpload}
                    locale={locale}
                  />
                  {/* High-stakes confirmation: show an amber warning when the
                      field's value matches its configured warningOnValue (e.g.
                      a "No" to the related-party question → $25k IRS penalty). */}
                  {field.warningOnValue && String(formData[field.name] ?? '') === field.warningOnValue.value && (
                    <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2 text-xs text-amber-800 leading-relaxed">
                      <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                      <span>{locale === 'it' && field.warningOnValue.textIt ? field.warningOnValue.textIt : field.warningOnValue.text}</span>
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
