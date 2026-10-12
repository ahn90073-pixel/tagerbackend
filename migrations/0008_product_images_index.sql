-- Add the image lookup/order index to every existing tenant schema.
DO $$
DECLARE
  tenant record;
BEGIN
  FOR tenant IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name ~ '^tenant_[a-z0-9_]{1,54}$'
  LOOP
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS product_images_product_order_idx ON %I.product_images (product_id, is_primary DESC, sort_order ASC, created_at ASC)',
      tenant.schema_name
    );
  END LOOP;
END;
$$;
