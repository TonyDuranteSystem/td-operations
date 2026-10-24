/**
 * Calendar "Message client" / job chat: which topic does a staff message go under?
 * Default = the job's own topic (service type + year, e.g. "ITIN" or "Tax Return 2025"). Staff may pick another open topic of the
 * same chat or type a new one. A typed name that matches an existing topic ignoring case/spaces reuses that spelling, so it never opens
 * a duplicate tab for the client. Pure — the route and its tests share it.
 */
import { normalizeTopic, resolveTypedTopic } from "@/lib/portal/document-share-text"

export function chooseFlowMessageTopic(args: { requested: unknown; defaultTopic: string | null; existing: string[] }): string | null {
  const raw = typeof args.requested === "string" ? normalizeTopic(args.requested) : ""
  if (!raw) return args.defaultTopic
  return resolveTypedTopic(raw, args.defaultTopic ? [args.defaultTopic, ...args.existing] : args.existing)
}
