-- Flexible-offer track, Step 0 (dev job d2971d11): a service created in the Service Catalog screen is recognised by the system.
-- The Service Catalog screen writes through the service_catalog VIEW, whose INSTEAD OF trigger (service_catalog_iud) creates the
-- catalog row. That trigger always wrote EMPTY tags, so a brand-new service carried none of the tags the rest of the system reads
-- (start at payment, sellable, ...) and was ignored by them. One change, nothing else:
--   * INSERT: a service that has a pipeline name gets the default tags  service, sd, sellable, start_at_activation.
--     A row WITHOUT a pipeline (a plain billing item such as "Additional service") keeps empty tags, exactly as today.
--   * UPDATE: if a service had no pipeline and the edit gives it one, AND its tags are still empty, it gets the same default tags.
--     Any row that already has tags (every historical service) is never touched, and so is a service whose pipeline was already set.
-- No existing row is changed by this migration (no backfill): "Annual Renewal" and the other untagged legacy rows stay as they are.
-- Staff can still change a service's tags later in the CRM /catalog page. Undo: 20261022-1200-new-service-default-tags.UNDO.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.service_catalog_iud()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_existing_metadata jsonb;
  v_new_metadata      jsonb;
  v_new_tags          jsonb;
  v_pipeline_newly_set boolean;
  v_new_status        text;
  v_slug              text;
  v_base_slug         text;
  v_suffix            int;
  v_default_tags      jsonb := '["service", "sd", "sellable", "start_at_activation"]'::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_slug := NEW.slug;
    IF v_slug IS NULL OR length(trim(v_slug)) = 0 THEN
      v_base_slug := trim(both '_' from regexp_replace(lower(COALESCE(NEW.name, '')), '[^a-z0-9_]+', '_', 'g'));
      IF length(v_base_slug) = 0 THEN
        v_base_slug := 'service';
      END IF;
      v_slug := v_base_slug;
      v_suffix := 2;
      WHILE EXISTS (SELECT 1 FROM catalog_entries WHERE catalog_id = 'services' AND slug = v_slug) LOOP
        v_slug := v_base_slug || '_' || v_suffix::text;
        v_suffix := v_suffix + 1;
      END LOOP;
    END IF;

    v_new_metadata := jsonb_build_object(
      'legacy_in_service_catalog', true,
      'legacy_name',               NEW.name,
      'pipeline',                  NEW.pipeline,
      'contract_type',             NEW.contract_type,
      'has_annual',                NEW.has_annual,
      'default_price',             NEW.default_price,
      'default_currency',          NEW.default_currency,
      'sort_order',                NEW.sort_order,
      'category',                  NEW.category,
      'description_legacy',        NEW.description,
      'supports_quantity',         NEW.supports_quantity,
      'default_service_context',   NEW.default_service_context
    );
    v_new_status := CASE WHEN COALESCE(NEW.active, true) THEN 'active' ELSE 'deprecated' END;
    v_new_tags := CASE WHEN length(btrim(COALESCE(NEW.pipeline, ''))) > 0 THEN v_default_tags ELSE '[]'::jsonb END;

    INSERT INTO catalog_entries (
      catalog_id, slug, display_name, description, status, tags, metadata, capabilities,
      display_name_translations, description_translations
    )
    VALUES (
      'services', v_slug, NEW.name, NEW.description, v_new_status,
      v_new_tags, v_new_metadata, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
    )
    RETURNING id INTO NEW.id;
    NEW.slug := v_slug;
    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    SELECT metadata INTO v_existing_metadata FROM catalog_entries WHERE id = OLD.id;
    v_new_metadata := COALESCE(v_existing_metadata, '{}'::jsonb) || jsonb_build_object(
      'legacy_in_service_catalog', true,
      'legacy_name',               NEW.name,
      'pipeline',                  NEW.pipeline,
      'contract_type',             NEW.contract_type,
      'has_annual',                NEW.has_annual,
      'default_price',             NEW.default_price,
      'default_currency',          NEW.default_currency,
      'sort_order',                NEW.sort_order,
      'category',                  NEW.category,
      'description_legacy',        NEW.description,
      'supports_quantity',         NEW.supports_quantity,
      'default_service_context',   NEW.default_service_context
    );
    v_new_status := CASE WHEN COALESCE(NEW.active, true) THEN 'active' ELSE 'deprecated' END;
    -- Decided inside the UPDATE below (tags = '[]' is checked on the row at write time), so a concurrent
    -- retag in the CRM /catalog page can never be overwritten by a value read earlier in this trigger.
    v_pipeline_newly_set := length(btrim(COALESCE(OLD.pipeline, ''))) = 0
                        AND length(btrim(COALESCE(NEW.pipeline, ''))) > 0;

    UPDATE catalog_entries
       SET display_name = NEW.name,
           description  = NEW.description,
           status       = v_new_status,
           metadata     = v_new_metadata,
           tags         = CASE WHEN v_pipeline_newly_set AND COALESCE(tags, '[]'::jsonb) = '[]'::jsonb THEN v_default_tags ELSE tags END,
           updated_at   = now()
     WHERE id = OLD.id;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    UPDATE catalog_entries
       SET status   = 'deprecated',
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('legacy_in_service_catalog', false),
           updated_at = now()
     WHERE id = OLD.id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$function$;

COMMIT;
