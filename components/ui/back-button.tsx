'use client'

import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

export function BackButton({ className }: { className?: string }) {
  const router = useRouter()
  return (
    <button onClick={() => router.back()} className={cn('p-2 rounded-lg hover:bg-zinc-100 transition-colors', className)}>
      <ArrowLeft className="h-5 w-5" />
    </button>
  )
}
