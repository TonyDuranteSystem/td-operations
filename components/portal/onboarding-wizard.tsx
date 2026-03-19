'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  LayoutDashboard, FileText, Receipt, MessageSquare,
  Cog, ChevronRight, CheckCircle2, ArrowRight,
} from 'lucide-react'

const STEPS = [
  {
    icon: LayoutDashboard,
    title: 'Your Dashboard',
    description: 'See your company info, active services, upcoming deadlines, and payment history — all in one place.',
    color: 'text-blue-600 bg-blue-100',
  },
  {
    icon: FileText,
    title: 'Documents',
    description: 'Browse, download, and upload documents related to your company. Everything is securely stored.',
    color: 'text-purple-600 bg-purple-100',
  },
  {
    icon: Receipt,
    title: 'Invoices',
    description: 'Create professional invoices for your customers in USD or EUR. Download as PDF or send via email.',
    color: 'text-emerald-600 bg-emerald-100',
  },
  {
    icon: MessageSquare,
    title: 'Chat',
    description: 'Message our team directly from the portal. Get real-time responses without leaving the app.',
    color: 'text-amber-600 bg-amber-100',
  },
  {
    icon: Cog,
    title: 'Services',
    description: 'Track the progress of every service — LLC formation, EIN application, tax returns, and more.',
    color: 'text-rose-600 bg-rose-100',
  },
]

interface OnboardingWizardProps {
  userName: string
  onComplete: () => void
}

export function OnboardingWizard({ userName, onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState(0) // 0 = welcome, 1-5 = features, 6 = done
  const router = useRouter()

  const handleComplete = async () => {
    // Mark onboarding as complete via API
    await fetch('/api/portal/onboarding-complete', { method: 'POST' })
    onComplete()
    router.refresh()
  }

  // Welcome screen
  if (step === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-br from-blue-600 to-blue-800">
        <div className="text-center text-white max-w-md mx-4">
          <div className="w-20 h-20 rounded-2xl bg-white/20 flex items-center justify-center mx-auto mb-6">
            <span className="text-4xl font-bold">TD</span>
          </div>
          <h1 className="text-3xl font-bold mb-3">
            Welcome{userName ? `, ${userName.split(' ')[0]}` : ''}!
          </h1>
          <p className="text-blue-100 text-lg mb-8">
            Your client portal is ready. Let us show you around.
          </p>
          <button
            onClick={() => setStep(1)}
            className="inline-flex items-center gap-2 px-8 py-3 bg-white text-blue-700 rounded-xl font-semibold hover:bg-blue-50 transition-colors"
          >
            Get Started <ArrowRight className="h-5 w-5" />
          </button>
          <button
            onClick={handleComplete}
            className="block mx-auto mt-4 text-sm text-blue-200 hover:text-white"
          >
            Skip tour
          </button>
        </div>
      </div>
    )
  }

  // Feature steps
  if (step <= STEPS.length) {
    const feature = STEPS[step - 1]
    const Icon = feature.icon
    const isLast = step === STEPS.length

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-white rounded-2xl shadow-xl max-w-md mx-4 p-8">
          {/* Progress dots */}
          <div className="flex justify-center gap-2 mb-6">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-2 rounded-full transition-all ${
                  i < step ? 'w-2 bg-blue-600' : i === step - 1 ? 'w-6 bg-blue-600' : 'w-2 bg-zinc-200'
                }`}
              />
            ))}
          </div>

          {/* Feature card */}
          <div className="text-center">
            <div className={`w-16 h-16 rounded-2xl ${feature.color} flex items-center justify-center mx-auto mb-4`}>
              <Icon className="h-8 w-8" />
            </div>
            <h2 className="text-xl font-semibold text-zinc-900 mb-2">{feature.title}</h2>
            <p className="text-zinc-500">{feature.description}</p>
          </div>

          {/* Actions */}
          <div className="flex justify-between mt-8">
            <button
              onClick={() => setStep(step - 1)}
              className="px-4 py-2 text-sm text-zinc-500 hover:text-zinc-700"
            >
              Back
            </button>
            <button
              onClick={() => isLast ? handleComplete() : setStep(step + 1)}
              className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
            >
              {isLast ? (
                <>Done <CheckCircle2 className="h-4 w-4" /></>
              ) : (
                <>Next <ChevronRight className="h-4 w-4" /></>
              )}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return null
}
