-- ITIN is MAIL-ONLY: remove the wrong "Fax the W-7 package to the IRS" step.
--
-- Context (Luca, Slack td-dev 2026-07-01): the ITIN "Submitted to IRS" staff
-- workspace stage shows a `fax_irs` card reading "Fax the signed W-7 package to
-- the IRS" and a stage description "Mail or fax the ITIN package to IRS."
-- W-7 / ITIN packages are submitted BY MAIL ONLY (the correct IRS ITIN Operation
-- PO Box is already shown in the waiting_notice on this stage). The `fax_irs`
-- component is shared with SS-4 / Tax Return (which legitimately fax) and was
-- wrongly copied onto the ITIN flow.
--
-- Fix: drop the `fax_irs` component from the ITIN "Submitted to IRS" stage_layout
-- and correct the staff-facing stage description to mail-only. The client-facing
-- copy (client_description "Your ITIN application has been mailed to the IRS.")
-- was already correct and is untouched.
--
-- Idempotent: filtering fax_irs out of the components array is a no-op on re-run.
UPDATE pipeline_stages
SET stage_layout = jsonb_set(
      (stage_layout - 'components') || jsonb_build_object(
        'components',
        COALESCE(
          (SELECT jsonb_agg(c)
             FROM jsonb_array_elements(stage_layout->'components') AS c
            WHERE c->>'type' <> 'fax_irs'),
          '[]'::jsonb
        )
      ),
      '{description}',
      to_jsonb('Mail the ITIN (W-7) package to the IRS. Upload the mailing/tracking receipt.'::text),
      true
    )
WHERE service_type = 'ITIN'
  AND stage_name = 'Submitted to IRS';
