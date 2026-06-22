'use client'

import { useRouter } from 'next/navigation'
import { Building2, Users } from 'lucide-react'
import { cn } from '@/lib/utils'

interface RoleSwitcherProps {
  currentMode: 'client' | 'partner'
  locale?: string
}

export function RoleSwitcher({ currentMode, locale }: RoleSwitcherProps) {
  const router = useRouter()

  const switchToClient = () => {
    document.cookie = 'portal_active_role=client; path=/; max-age=86400'
    router.push('/portal')
    router.refresh()
  }

  const switchToPartner = () => {
    document.cookie = 'portal_active_role=partner; path=/; max-age=86400'
    router.push('/portal/partner/clients')
    router.refresh()
  }

  const clientLabel = locale === 'it' ? 'La Mia Azienda' : 'My Company'
  const partnerLabel = 'Partner'

  return (
    <div className="mx-3 mb-2 p-1 bg-zinc-100 rounded-lg flex gap-1">
      <button
        onClick={switchToClient}
        className={cn(
          'flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-colors',
          currentMode === 'client'
            ? 'bg-white text-zinc-900 shadow-sm'
            : 'text-zinc-500 hover:text-zinc-700'
        )}
      >
        <Building2 className="h-3 w-3" />
        {clientLabel}
      </button>
      <button
        onClick={switchToPartner}
        className={cn(
          'flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-colors',
          currentMode === 'partner'
            ? 'bg-white text-zinc-900 shadow-sm'
            : 'text-zinc-500 hover:text-zinc-700'
        )}
      >
        <Users className="h-3 w-3" />
        {partnerLabel}
      </button>
    </div>
  )
}
