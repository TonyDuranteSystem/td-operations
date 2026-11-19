// Client iPhone app, Overview redesign (dev job 056a70d0): hiding an ITIN or passport number until the client taps Show.
//
// A phone screen is easy for other people to see, so the numbers on the Identity & Tax card start hidden. Only the LAST four letters/digits
// stay readable (enough for the client to recognise the number), everything else becomes a dot; dashes and spaces stay where they were so the
// shape of the number is still clear. A value of four or fewer characters is hidden completely: showing all of it would defeat the point.

const DOT = '•'

export function maskSecret(value: string, keep = 4): string {
  const chars = Array.from(value)
  const isKept = (c: string) => /[A-Za-z0-9]/.test(c) // ITIN and passport numbers are plain letters and digits
  const total = chars.filter(isKept).length
  if (total === 0) return value
  const hideUntil = total <= keep ? total : total - keep // how many letters/digits, counted from the left, become dots
  let seen = 0
  return chars
    .map(c => {
      if (!isKept(c)) return c
      seen += 1
      return seen <= hideUntil ? DOT : c
    })
    .join('')
}
