import { createContext, useContext } from 'react'

/**
 * "Is this document a floating window?" — the frozen answer, shared with anything that needs it
 * (dev job f3f3e237, step 4). Lives in a plain .ts module (no JSX) so pure-logic modules such as
 * lib/hooks/use-selection-history.ts can read it without pulling a component file into a node
 * test. The provider that sets it, and freezes it, is components/dashboard/embedded-shell.tsx.
 */
export const EmbeddedContext = createContext(false)

export function useEmbedded(): boolean {
  return useContext(EmbeddedContext)
}
