/**
 * The red dot beside "WhatsApp" in the left menu (Antonio 2026-11-19: "a red dot that something is going on, with a description").
 * ONE sentence for the worst thing a person should know about the self-hosted WhatsApp line right now, or null when all is well.
 * The page's banner keeps the full explanation and the buttons; this is only the pointer.
 */
export interface AttentionInput {
  /** from classifyBridge */
  health: string
  /** the link-problem headline, when there is one */
  problemText: string | null
  update: { level: "problem" | "warning"; title: string; text: string } | null
  voiceCheck: { level: "info" | "ask" | "warning" | "problem"; title: string } | null
}

export interface Attention {
  level: "problem" | "warning"
  text: string
}

export function attentionSummary(i: AttentionInput): Attention | null {
  const linkDown = i.health !== "ok" && i.health !== "unmonitored" && i.health !== "none"
  if (linkDown) return { level: "problem", text: i.problemText ?? "WhatsApp is not connected — new messages may not arrive." }
  if (i.update?.level === "problem") return { level: "problem", text: i.update.title }
  if (i.voiceCheck?.level === "problem") return { level: "problem", text: i.voiceCheck.title }
  if (i.update) return { level: "warning", text: i.update.title }
  if (i.voiceCheck && i.voiceCheck.level !== "info") return { level: "warning", text: i.voiceCheck.title }
  return null
}
