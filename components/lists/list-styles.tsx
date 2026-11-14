/**
 * Makes the Accounts and Contacts lists reflow by the room the table really has, not by the screen size.
 *
 * The table sits in a box named "lists". When that box is at least `minWidth` wide (the room the chosen fields need), every chosen field
 * is its own column. Narrower than that, the chosen fields drop to one small line under the name instead of being cut off, and the
 * columns come back by themselves when there is room. Pure CSS (a container query), so there is no flash on load.
 *
 * Classes: `lc-row` = the row's wide column template (from --cols) · `lc-x` / `lc-xf` = a field's own column (block / flex), only when
 * wide · `lc-m` = the small line under the name, only when narrow.
 */
export const LISTS_CONTAINER = { containerType: 'inline-size', containerName: 'lists' } as const

export function ListStyles({ minWidth }: { minWidth: number }) {
  const n = Math.max(0, Math.ceil(minWidth))
  const css = `.lc-x,.lc-xf{display:none}.lc-m{display:block}@container lists (min-width:${n}px){.lc-x{display:block}.lc-xf{display:flex}.lc-m{display:none}.lc-row{grid-template-columns:var(--cols)}}`
  return <style>{css}</style>
}
