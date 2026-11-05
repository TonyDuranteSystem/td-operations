import { headers } from 'next/headers'
import { isAppModeUserAgent } from '@/lib/app-mode/app-mode'

/**
 * App mode for the CURRENT request (server components and layouts only). Reads the browser name once; layouts
 * hand the answer to <AppModeProvider> so client components can follow it (useAppMode).
 */
export function getAppMode(): boolean {
  return isAppModeUserAgent(headers().get('user-agent'))
}
