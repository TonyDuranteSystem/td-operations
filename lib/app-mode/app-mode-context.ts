import { createContext, useContext } from 'react'

/**
 * "Is this page inside the TD Social app?" — shared with anything that needs it. A plain .ts module (no JSX)
 * so pure-logic modules can read it without pulling a component file into a node test, the same way
 * lib/embed/embedded-context.ts does for windows. The provider that sets it is
 * components/app-mode/app-mode-provider.tsx.
 */
export const AppModeContext = createContext(false)

export function useAppMode(): boolean {
  return useContext(AppModeContext)
}
