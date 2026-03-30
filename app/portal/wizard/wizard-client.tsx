'use client'

import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { WizardShell } from '@/components/portal/wizard/wizard-shell'
import { WizardField } from '@/components/portal/wizard/wizard-field'
import { getWizardConfig, MEMBER_FIELDS } from '@/components/portal/wizard/wizard-configs'
import { CheckCircle, Plus, Trash2 } from 'lucide-react'

interface WizardClientProps {
  wizardType: string
  entityType: string
  prefillData: Record<string, string>
  savedData: Record<string, string>
  savedStep: number
  progressId: string | null
  accountId: string
  contactId: string
  locale: 'en' | 'it'
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
  locale,
}: WizardClientProps) {
  const { steps, fields } = getWizardConfig(wizardType, entityType)

  // Merge prefill → saved → current (saved takes precedence over prefill, but only for non-empty values)
  // Empty saved values (from stale records saved before prefill fix) must NOT override prefill
  const filteredSaved = Object.fromEntries(
    Object.entries(savedData).filter(([, v]) => v !== '' && v !== null && v !== undefined)
  )
  const initialData = { ...prefillData, ...filteredSaved }

  const [currentStep, setCurrentStep] = useState(savedStep)
  const [formData, setFormData] = useState<Record<string, string | boolean | number>>(initialData)
  const [memberCount, setMemberCount] = useState(Number(initialData.member_count) || 1)
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

  const handleFieldChange = useCallback((name: string, value: string | boolean | number) => {
    setFormData(prev => ({ ...prev, [name]: value }))
  }, [])

  // File upload handler — uploads to Supabase Storage, returns path
  const handleFileUpload = useCallback(async (fieldName: string, file: File): Promise<string | null> => {
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('field_name', fieldName)
      fd.append('wizard_type', wizardType)
      fd.append('identifier', accountId || contactId || 'unknown')

      const res = await fetch('/api/portal/wizard-upload', {
        method: 'POST',
        body: fd,
      })

      if (!res.ok) return null
      const { path } = await res.json()
      return path
    } catch {
      return null
    }
  }, [wizardType, accountId, contactId])

  // Validate current step
  const validateStep = useCallback(() => {
    const stepId = steps[currentStep].id
    const stepFields = fields[stepId] || []
    for (const field of stepFields) {
      // Skip validation for hidden conditional fields
      if (field.conditional) {
        const refValue = formData[field.conditional.field]
        if (String(refValue) !== field.conditional.value) continue
      }
      if (field.required) {
        const val = formData[field.name]
        if (!val || (typeof val === 'string' && !val.trim())) return false
      }
    }
    return true
  }, [currentStep, steps, fields, formData])

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
  }, [wizardType, currentStep, formData, accountId, contactId, currentProgressId, locale])

  // Submit wizard
  const handleSubmit = useCallback(async () => {
    if (!validateStep()) {
      toast.error(locale === 'it' ? 'Compila tutti i campi obbligatori' : 'Please fill all required fields')
      return
    }

    setIsSubmitting(true)
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
          progress_id: currentProgressId,
        }),
      })

      if (res.ok) {
        setIsSubmitted(true)
        toast.success(locale === 'it' ? 'Dati inviati con successo!' : 'Data submitted successfully!')
      } else {
        const err = await res.json()
        toast.error(err.error || 'Submission failed')
      }
    } catch {
      toast.error('Submission failed')
    } finally {
      setIsSubmitting(false)
    }
  }, [wizardType, entityType, formData, accountId, contactId, currentProgressId, validateStep, locale])

  // Auto-save on step change
  const handleStepChange = useCallback((step: number) => {
    setCurrentStep(step)
    // Auto-save in background (only if user has entered data)
    const hasData = Object.keys(formData).some(k => formData[k] !== undefined && formData[k] !== '')
    if (hasData && (accountId || contactId)) {
      fetch('/api/portal/wizard-progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wizard_type: wizardType,
          current_step: step,
          data: formData,
          account_id: accountId || null,
          contact_id: contactId || null,
          progress_id: currentProgressId,
        }),
      }).then(res => res.ok ? res.json() : null)
        .then(result => { if (result?.id) setCurrentProgressId(result.id) })
        .catch(() => {
          console.warn('[wizard] Auto-save failed — data preserved in memory')
        })
    }
  }, [wizardType, formData, accountId, contactId, currentProgressId])

  // Success screen
  if (isSubmitted) {
    return (
      <div className="max-w-lg mx-auto text-center py-16">
        <div className="h-16 w-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <CheckCircle className="h-8 w-8 text-green-600" />
        </div>
        <h2 className="text-2xl font-bold mb-2">
          {locale === 'it' ? 'Dati inviati con successo!' : 'Data submitted successfully!'}
        </h2>
        <p className="text-zinc-500 mb-6">
          {locale === 'it'
            ? 'Il nostro team esaminerà le informazioni e ti contatterà a breve.'
            : 'Our team will review your information and contact you shortly.'}
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
    >
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
                      // Clear this member's fields
                      setFormData(prev => {
                        const next = { ...prev }
                        MEMBER_FIELDS.forEach(f => { delete next[`member_${idx}_${f.name}`] })
                        return next
                      })
                    }}
                    className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1"
                  >
                    <Trash2 className="h-3 w-3" /> {locale === 'it' ? 'Rimuovi' : 'Remove'}
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {MEMBER_FIELDS.map(field => (
                  <div key={`${idx}_${field.name}`} className={field.type === 'textarea' ? 'md:col-span-2' : ''}>
                    <WizardField
                      field={field}
                      value={formData[`member_${idx}_${field.name}`] ?? ''}
                      onChange={(name, value) => handleFieldChange(`member_${idx}_${name}`, value)}
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
              setMemberCount(c => c + 1)
              handleFieldChange('member_count', memberCount + 1)
            }}
            className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 font-medium"
          >
            <Plus className="h-4 w-4" />
            {locale === 'it' ? 'Aggiungi membro' : 'Add member'}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {stepFields
            .filter(field => {
              // Repeater fields always render (they have their own visibility logic)
              if (field.type === 'repeater') return true
              // Conditional show/hide: only render if the referenced field has the expected value
              if (field.conditional) {
                const refValue = formData[field.conditional.field]
                return String(refValue) === field.conditional.value
              }
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
                      <span className="text-xs text-zinc-400">{locale === 'it' ? '(opzionale)' : '(optional)'}</span>
                    </div>
                    {count === 0 && (
                      <p className="text-xs text-zinc-400 italic">
                        {locale === 'it' ? 'Nessuna transazione aggiunta.' : 'No entries added yet.'}
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
                </div>
              )
            })}
        </div>
      )}
    </WizardShell>
  )
}
