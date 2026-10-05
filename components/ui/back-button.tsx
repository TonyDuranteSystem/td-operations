'use client'

import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useEmbedded } from '@/lib/embed/embedded-context'

export function BackButton({ className }: { className?: string }) {
  const router = useRouter()
  // Inside a floating window "back" is disabled (it would step the whole browser tab), so a
  // dead arrow would only confuse: render nothing there.
  if (useEmbedded()) return null
  return (
    <button onClick={() => router.back()} className={cn('p-2 rounded-lg hover:bg-zinc-100 transition-colors', className)}>
      <ArrowLeft className="h-5 w-5" />
    </button>
  )
}
