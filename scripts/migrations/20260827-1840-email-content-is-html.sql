-- Inbox local-copy render bug (dev_task 1c453653-e93a-4875-bcd6-6033070d062b).
--
-- lib/email-store/read.ts decided HTML-vs-plain-text for a locally-captured
-- email by scanning its saved text for any "<...>" pattern (content-sniffing).
-- That is the exact anti-pattern already fixed once for the live-Gmail-fetch
-- path on 2026-07-08 (commit 88117e73, lib/gmail.ts extractBodyWithType) —
-- guessing from content misfires on ordinary plain text that merely contains a
-- bracketed link ("site.com <http://site.com/>") or a quoted address
-- ("Name <a@b.com>"), losing every real line break when misrendered as HTML.
--
-- lib/email-store/capture.ts already computes the REAL answer (from Gmail's
-- own MIME type, via extractBodyWithType) at capture time — it was just never
-- persisted. This column lets the writer save it and the reader trust it
-- instead of re-guessing.
--
-- Nullable, no default, no backfill in this migration: existing captured rows
-- (tens of thousands) keep NULL until either (a) a one-time repair pass
-- (lib/email-store/repair-is-html.ts) fills them in from a lightweight Gmail
-- re-fetch, or (b) read.ts's tightened fallback regex is used meanwhile. Same
-- accepted transitional shape this table already uses for deleted_at
-- (20260804-0100-email-deletion-bin.sql).

ALTER TABLE email_message_content
  ADD COLUMN IF NOT EXISTS is_html boolean;

COMMENT ON COLUMN email_message_content.is_html IS
  'Real MIME-derived HTML-vs-plain-text flag, computed once at capture time by extractBodyWithType and persisted here so read.ts never has to re-guess from content. NULL = captured before this column existed; repair-is-html.ts backfills these via a lightweight Gmail re-fetch (no attachment/body re-download).';
