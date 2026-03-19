'use client'

import { useState } from 'react'
import { OnboardingWizard } from './onboarding-wizard'

interface OnboardingWrapperProps {
  showOnboarding: boolean
  userName: string
}

export function OnboardingWrapper({ showOnboarding, userName }: OnboardingWrapperProps) {
  const [show, setShow] = useState(showOnboarding)

  if (!show) return null

  return <OnboardingWizard userName={userName} onComplete={() => setShow(false)} />
}
