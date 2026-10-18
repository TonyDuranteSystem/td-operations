/** One CSV cell: quoted (and inner quotes doubled) whenever it holds a comma, a quote or a line break. */
export function csvCell(value: unknown): string {
  const s = String(value ?? "")
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** RFC 2047 header value (R041): safe for any non-ASCII character such as an em dash. */
export function encodeMimeSubject(subject: string): string {
  return `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
}
