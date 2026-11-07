-- Tax questionnaire review: staff write a request next to a client answer (dev job 7df278cd, Shipment 1).
-- ONE new optional field on the tax submission. Shape (written only by the app, never by hand):
--   { "draft":  { "requests": { "<answer key>": "<note>" }, "message": "<optional note to the client>" },
--     "rounds": [ { "sent_at": "...", "by": "...", "message": "...", "requests": [ { "key", "label", "group", "note", "was" } ] } ] }
-- "draft" = what staff have written but not sent; "rounds" = every Request Changes press that carried requests (the story).
-- Additive and nullable: nothing existing reads it, a row without it behaves exactly as before.
ALTER TABLE public.tax_return_submissions ADD COLUMN IF NOT EXISTS review_requests jsonb;
COMMENT ON COLUMN public.tax_return_submissions.review_requests IS 'Staff review requests next to client answers: { draft:{requests,message}, rounds:[{sent_at,by,message,requests:[{key,label,group,note,was}]}] }. Written by the app only.';
