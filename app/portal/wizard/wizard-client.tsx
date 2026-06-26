'use client'

import { useState, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { WizardShell } from '@/components/portal/wizard/wizard-shell'
import { WizardField } from '@/components/portal/wizard/wizard-field'
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

  const handleFieldChange = useCallback((name: string, value: string | string[] | boolean | number) => {
    setFormData(prev => ({ ...prev, [name]: value }))
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
      // Skip validation for hidden conditional fields
      if (field.conditional) {
        const refValue = formData[field.conditional.field]
        if (String(refValue) !== field.conditional.value) continue
      }
      // Required repeater (e.g. related-party transactions once the gate is "Yes"):
      // at least one row, and every required sub-field of every row must be filled.
      if (field.type === 'repeater') {
        if (field.required) {
          const count = Number(formData[`${field.name}_count`]) || 0
          if (count < 1) return false
          for (let i = 0; i < count; i++) {
            for (const rf of field.repeaterFields || []) {
              if (rf.required && isEmptyValue(formData[`${field.name}_${i}_${rf.name}`])) return false
            }
          }
        }
        continue
      }
      if (field.required && isEmptyValue(formData[field.name])) return false
    }
    return true
  }, [currentStep, steps, fields, formData, memberCount])

  // Save progress to wizard_progress table
  const handleSave = useCallback(async () => {
    setIsSaving(true)
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
        toast.success(locale === 'it' ? 'Bozza salvata' : 'Draft saved')
      } else {
        toast.error(locale === 'it' ? 'Errore nel salvataggio' : 'Save failed')
      }
    } catch {
      toast.error(locale === 'it' ? 'Errore nel salvataggio' : 'Save failed')
    } finally {
      setIsSaving(false)
    }
  }, [wizardType, currentStep, formData, accountId, contactId, leadId, currentProgressId, locale])

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
          allow_resubmit: isResubmitMode || undefined,
        }),
      })

      if (res.ok) {
        setIsSubmitted(true)
        toast.success(locale === 'it' ? 'Dati inviati con successo!' : 'Data submitted successfully!')
        return
      }

      // Try to parse structured validation error: { error, fields: [{ field, message }] }
      const err = await res.json().catch(() => ({} as { error?: string; fields?: FieldError[] }))
      if (res.status === 400 && Array.isArray(err?.fields) && err.fields.length > 0) {
        setFieldErrors(err.fields)
        const first = err.fields[0]
        toast.error(`${first.field}: ${first.message}`)
      } else {
        toast.error(err?.error || (locale === 'it' ? 'Invio fallito' : 'Submission failed'))
      }
    } catch {
      toast.error(locale === 'it' ? 'Invio fallito' : 'Submission failed')
    } finally {
      setIsSubmitting(false)
    }
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
          {locale === 'it'
            ? 'Il nostro team esaminerà le informazioni e ti contatterà a breve.'
            : 'Our team will review your information and contact you shortly.'}
        </p>
        {isBanking ? (
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
                      setMemberCount(c => c - 1)
                      // Clear this member's fields + signer flag
                      setFormData(prev => {
                        const next = { ...prev }
                        stepFields.forEach(f => { delete next[`member_${idx}_${f.name}`] })
                        delete next[`member_${idx}_is_signer`]
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
              // has_related_party_transactions = 'Yes' answer. (Previously
              // repeaters short-circuited to always-render, which would have
              // made that gate inert.)
              if (field.conditional) {
                const refValue = formData[field.conditional.field]
                return String(refValue) === field.conditional.value
              }
              // Repeaters without a conditional always render.
              if (field.type === 'repeater') return true
              return true
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
                      {field.required
                        ? <span className="text-xs font-semibold text-red-500">{locale === 'it' ? '(obbligatorio)' : '(required)'}</span>
                        : <span className="text-xs text-zinc-400">{locale === 'it' ? '(opzionale)' : '(optional)'}</span>}
                    </div>
                    {(locale === 'it' && field.hintIt ? field.hintIt : field.hint) && (
                      <p className="text-xs text-zinc-500 leading-relaxed">{locale === 'it' && field.hintIt ? field.hintIt : field.hint}</p>
                    )}
                    {count === 0 && (
                      <p className={`text-xs italic ${field.required ? 'text-red-500' : 'text-zinc-400'}`}>
                        {field.required
                          ? (locale === 'it' ? 'Aggiungi almeno una transazione per continuare.' : 'Add at least one transaction to continue.')
                          : (locale === 'it' ? 'Nessuna transazione aggiunta.' : 'No entries added yet.')}
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
                                const next = { ...prev }
                                field.repeaterFields?.forEach(rf => { delete next[`${field.name}_${idx}_${rf.name}`] })
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
                            <div key={rf.name} className={rf.type === 'textarea' ? 'md:col-span-2' : ''}>
                              <WizardField
                                field={rf}
                                value={formData[`${field.name}_${idx}_${rf.name}`] ?? ''}
                                onChange={(name, value) => handleFieldChange(`${field.name}_${idx}_${name}`, value)}
                                locale={locale}
                              />
                            </div>
                          ))}
                        </div>
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
