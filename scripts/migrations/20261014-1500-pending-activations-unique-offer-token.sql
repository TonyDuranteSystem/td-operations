-- One pending activation per signed offer (dev job ad09ea91 follow-up: "signing fired twice").
-- The signing handler asked "does an activation already exist?" and then inserted; two requests arriving together both heard "no"
-- and made two activations and two contacts. A unique index makes the database itself refuse the second one; the handler treats
-- that refusal as "already pending".
-- Production check before writing this (2026-10-14): 94 rows, 0 duplicate offer tokens, 0 null tokens — the index can be built as is.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_activations_offer_token ON public.pending_activations (offer_token);
