'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'

export function PasswordGate({ mustChangePassword }: { mustChangePassword: boolean }) {
  const pathname = usePathname()
  const router = useRouter()

  useEffect(() => {
    if (mustChangePassword && pathname !== '/portal/change-password' && pathname !== '/portal/reset-password') {
      router.replace('/portal/change-password')
    }
  }, [mustChangePassword, pathname, router])

  return null
}
