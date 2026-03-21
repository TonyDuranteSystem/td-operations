'use client'

import { useState, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Check, Loader2, Save } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface WizardStep {
  id: string
  title: string
  titleIt?: string
  description?: string
  descriptionIt?: string
}

interface WizardShellProps {
  steps: WizardStep[]
  currentStep: number
  onStepChange: (step: number) => void
  onSubmit: () => Promise<void>
  onSave?: () => Promise<void>
  canProceed: boolean
  isSubmitting: boolean
  isSaving?: boolean
  locale: 'en' | 'it'
  children: React.ReactNode
}

export function WizardShell({
  steps,
  currentStep,
  onStepChange,
  onSubmit,
  onSave,
  canProceed,
  isSubmitting,
  isSaving,
  locale,
  children,
}: WizardShellProps) {
  const isLastStep = currentStep === steps.length - 1
  const isFirstStep = currentStep === 0
  const progress = ((currentStep + 1) / steps.length) * 100

  const t = locale === 'it'
    ? { back: 'Indietro', next: 'Avanti', submit: 'Invia', saving: 'Salvando...', save: 'Salva bozza', step: 'Passo', of: 'di', submitting: 'Invio in corso...' }
    : { back: 'Back', next: 'Next', submit: 'Submit', saving: 'Saving...', save: 'Save draft', step: 'Step', of: 'of', submitting: 'Submitting...' }

  return (
    <div className="max-w-3xl mx-auto">
      {/* Progress bar */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-zinc-600">
            {t.step} {currentStep + 1} {t.of} {steps.length}
          </span>
          <span className="text-sm text-zinc-400">{Math.round(progress)}%</span>
        </div>
        <div className="h-2 bg-zinc-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-600 rounded-full transition-all duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Step indicators */}
      <div className="flex items-center gap-1 mb-6 overflow-x-auto pb-2">
        {steps.map((step, i) => (
          <button
            key={step.id}
            onClick={() => i < currentStep && onStepChange(i)}
            disabled={i > currentStep}
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors',
              i === currentStep && 'bg-blue-600 text-white',
              i < currentStep && 'bg-blue-50 text-blue-700 hover:bg-blue-100 cursor-pointer',
              i > currentStep && 'bg-zinc-100 text-zinc-400 cursor-not-allowed',
            )}
          >
            {i < currentStep ? (
              <Check className="h-3 w-3" />
            ) : (
              <span className="h-4 w-4 flex items-center justify-center rounded-full bg-white/20 text-[10px]">
                {i + 1}
              </span>
            )}
            {locale === 'it' && step.titleIt ? step.titleIt : step.title}
          </button>
        ))}
      </div>

      {/* Step content */}
      <div className="bg-white rounded-xl border shadow-sm p-6 mb-6">
        <h2 className="text-lg font-semibold mb-1">
          {locale === 'it' && steps[currentStep].titleIt
            ? steps[currentStep].titleIt
            : steps[currentStep].title}
        </h2>
        {steps[currentStep].description && (
          <p className="text-sm text-zinc-500 mb-6">
            {locale === 'it' && steps[currentStep].descriptionIt
              ? steps[currentStep].descriptionIt
              : steps[currentStep].description}
          </p>
        )}
        {children}
      </div>

      {/* Navigation buttons */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {!isFirstStep && (
            <button
              onClick={() => onStepChange(currentStep - 1)}
              className="flex items-center gap-1 px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50 transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
              {t.back}
            </button>
          )}
          {onSave && (
            <button
              onClick={onSave}
              disabled={isSaving}
              className="flex items-center gap-1 px-4 py-2 text-sm text-zinc-500 border border-dashed rounded-lg hover:bg-zinc-50 transition-colors"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {isSaving ? t.saving : t.save}
            </button>
          )}
        </div>

        {isLastStep ? (
          <button
            onClick={onSubmit}
            disabled={!canProceed || isSubmitting}
            className="flex items-center gap-1 px-6 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {isSubmitting ? t.submitting : t.submit}
          </button>
        ) : (
          <button
            onClick={() => canProceed && onStepChange(currentStep + 1)}
            disabled={!canProceed}
            className="flex items-center gap-1 px-6 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
          >
            {t.next}
            <ChevronRight className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}
