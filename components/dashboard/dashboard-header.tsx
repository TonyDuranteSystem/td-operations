'use client'

import { GlobalSearch } from '@/components/shared/global-search'
import { DashboardPushToggle } from '@/components/dashboard/push-toggle'
import { HelpToggle } from '@/components/help/help-toggle'
import { GlobalBackButton } from '@/components/dashboard/global-back-button'

export function DashboardHeader() {
  return (
    <header className="hidden lg:flex sticky top-0 z-30 h-14 items-center border-b bg-white/80 backdrop-blur-sm px-6 gap-4">
      <GlobalBackButton className="-ml-2" />
      <div className="flex-1 max-w-2xl">
        <GlobalSearch searchEndpoint="/api/search" mode="crm" placeholder="Search accounts, contacts, tasks, leads..." />
      </div>
      <HelpToggle />
      <DashboardPushToggle refreshOnMount />
    </header>
  )
}
