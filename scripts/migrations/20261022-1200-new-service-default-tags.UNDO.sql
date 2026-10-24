-- Undo of 20261022-1200-new-service-default-tags.sql: puts service_catalog_iud() back to its previous body (a new service gets empty tags).
-- Safe at any time. Services created while the new version was live KEEP the tags they were given (they are ordinary catalog data;
-- change them in the CRM /catalog page if wanted). Nothing else depends on the function body.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.service_catalog_iud()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_existing_metadata jsonb;
  v_new_metadata      jsonb;
  v_new_status        text;
  v_slug              text;
  v_base_slug         text;
  v_suffix            int;
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

    INSERT INTO catalog_entries (
      catalog_id, slug, display_name, description, status, tags, metadata, capabilities,
      display_name_translations, description_translations
    )
    VALUES (
      'services', v_slug, NEW.name, NEW.description, v_new_status,
      '[]'::jsonb, v_new_metadata, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
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

    UPDATE catalog_entries
       SET display_name = NEW.name,
           description  = NEW.description,
           status       = v_new_status,
           metadata     = v_new_metadata,
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
