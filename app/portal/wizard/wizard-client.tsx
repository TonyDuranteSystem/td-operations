'use client'

import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { WizardShell } from '@/components/portal/wizard/wizard-shell'
import { WizardField } from '@/components/portal/wizard/wizard-field'
import { getWizardConfig } from '@/components/portal/wizard/wizard-configs'
import { CheckCircle } from 'lucide-react'

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

  // Merge prefill → saved → current (saved takes precedence over prefill)
  const initialData = { ...prefillData, ...savedData }

  const [currentStep, setCurrentStep] = useState(savedStep)
  const [formData, setFormData] = useState<Record<string, string | boolean | number>>(initialData)
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
    // Auto-save in background
    if (accountId || contactId) {
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
        .catch(() => {}) // silent
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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {stepFields.map(field => (
          <div key={field.name} className={field.type === 'textarea' || field.type === 'checkbox' ? 'md:col-span-2' : ''}>
            <WizardField
              field={{ ...field, prefilled: !!prefillData[field.name] }}
              value={formData[field.name] ?? ''}
              onChange={handleFieldChange}
              onFileUpload={handleFileUpload}
              locale={locale}
            />
          </div>
        ))}
      </div>
    </WizardShell>
  )
}
