-- NEW, local proposal only. Requires reviewed/applied 001-005. Never reset data.
BEGIN;
DO $$ BEGIN
  IF has_schema_privilege('pos_owner','pos','CREATE')
    OR has_schema_privilege('pos_owner','public','CREATE') THEN
    RAISE EXCEPTION 'REVIEW_OWNER_CREATE_PRIVILEGES';
  END IF;
END $$;
GRANT CREATE ON SCHEMA pos, public TO pos_owner;
SELECT set_config('cai.catalog_migration_role',current_user,true);
SET LOCAL ROLE pos_owner;

CREATE TABLE pos.suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  email text NOT NULL DEFAULT '' CHECK (length(email)<=160),
  phone text NOT NULL DEFAULT '' CHECK (length(phone)<=40),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT pos.business_now()
);
ALTER TABLE pos.customers
  ADD COLUMN email text NOT NULL DEFAULT '' CHECK (length(email)<=160),
  ADD COLUMN phone text NOT NULL DEFAULT '' CHECK (length(phone)<=40),
  ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE pos.products
  ADD COLUMN category text NOT NULL DEFAULT 'Sin categoría' CHECK (length(btrim(category)) BETWEEN 1 AND 100),
  ADD COLUMN barcode text UNIQUE CHECK (length(barcode) BETWEEN 1 AND 100),
  ADD COLUMN purchase_price numeric(18,2) CHECK (purchase_price >= 0 AND purchase_price < 10000000000000000),
  ADD COLUMN minimum integer NOT NULL DEFAULT 0 CHECK (minimum >= 0),
  ADD COLUMN supplier_id uuid REFERENCES pos.suppliers(id),
  ADD COLUMN version integer NOT NULL DEFAULT 1;
CREATE TABLE pos.inventory_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES pos.products(id),
  supplier_id uuid REFERENCES pos.suppliers(id),
  quantity_delta integer NOT NULL CHECK (quantity_delta<>0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  created_by uuid NOT NULL REFERENCES pos.profiles(id),
  created_at timestamptz NOT NULL DEFAULT pos.business_now()
);
CREATE INDEX inventory_adjustments_product_idx ON pos.inventory_adjustments(product_id,created_at,id);
CREATE INDEX products_category_idx ON pos.products(category,id);
CREATE INDEX products_supplier_idx ON pos.products(supplier_id);
ALTER TABLE pos.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos.inventory_adjustments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pos.suppliers, pos.inventory_adjustments FROM PUBLIC, anon, authenticated, service_role, pos_app, pos_scheduler;
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON pos.inventory_adjustments
  FOR EACH ROW EXECUTE FUNCTION pos.prevent_financial_mutation();

CREATE FUNCTION public.cai_catalog(p_action text, p_data jsonb DEFAULT '{}', p_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_actor uuid; v_role text; v_id uuid; v_response jsonb;
  v_limit integer; v_offset integer; v_query text; v_delta integer;
  v_price numeric; v_cost numeric; v_supplier uuid; v_version integer;
BEGIN
  -- Gateway identity is mandatory even for reads. No actor supplied by React.
  v_actor := pos.current_profile_auth_uid();
  v_role := pos.require_staff(v_actor);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR octet_length(p_data::text)>32768 THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
  v_limit := coalesce((p_data->>'limit')::integer,50);
  v_offset := coalesce((p_data->>'offset')::integer,0);
  v_query := coalesce(p_data->>'search','');
  IF v_limit NOT BETWEEN 1 AND 100 OR v_offset NOT BETWEEN 0 AND 100000
    OR length(v_query)>100 THEN RAISE EXCEPTION 'INVALID_PAGINATION' USING ERRCODE='22023'; END IF;

  IF p_action='products.list' THEN
    WITH filtered AS (
      SELECT p.id,p.sku,p.name,p.price::text AS price,
        CASE WHEN v_role<>'cashier' THEN p.purchase_price::text END AS purchase_price,
        p.category,p.barcode,p.minimum,p.supplier_id,p.active,p.version,coalesce(b.quantity,0) AS stock
      FROM pos.products p LEFT JOIN pos.inventory_balances b ON b.product_id=p.id
      WHERE (v_role<>'cashier' OR p.active)
        AND (p.name ILIKE '%'||v_query||'%' OR p.sku ILIKE '%'||v_query||'%' OR p.barcode ILIKE '%'||v_query||'%')
        AND (coalesce(p_data->>'category','')='' OR p.category=p_data->>'category')
        AND (NOT coalesce((p_data->>'low_only')::boolean,false) OR coalesce(b.quantity,0)<=p.minimum)
    ) SELECT jsonb_build_object('total',(SELECT count(*) FROM filtered),'rows',
      coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM
        (SELECT * FROM filtered ORDER BY name,id LIMIT v_limit OFFSET v_offset) x),'[]'::jsonb)) INTO v_response;
    RETURN v_response;
  ELSIF p_action='directories.list' THEN
    WITH filtered AS (SELECT id,name,email,phone,active,version FROM pos.customers
      WHERE name ILIKE '%'||v_query||'%')
    SELECT jsonb_build_object('customers_total',(SELECT count(*) FROM filtered),
      'customers',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM
        (SELECT * FROM filtered ORDER BY name,id LIMIT v_limit OFFSET v_offset) x),'[]'::jsonb),
      'suppliers',CASE WHEN v_role='cashier' THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM
        (SELECT id,name,email,phone,active,version FROM pos.suppliers WHERE name ILIKE '%'||v_query||'%'
          ORDER BY name,id LIMIT v_limit OFFSET v_offset) x),'[]'::jsonb) END,
      'suppliers_total',CASE WHEN v_role='cashier' THEN 0 ELSE
        (SELECT count(*) FROM pos.suppliers WHERE name ILIKE '%'||v_query||'%') END) INTO v_response;
    RETURN v_response;
  ELSIF p_action='inventory.history' THEN
    v_id := (p_data->>'product_id')::uuid;
    RETURN coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
      SELECT * FROM (
        SELECT id,quantity_delta,'sale'::text AS kind,created_at,created_by FROM pos.inventory_movements WHERE product_id=v_id
        UNION ALL
        SELECT id,quantity_delta,reason,created_at,created_by FROM pos.inventory_adjustments WHERE product_id=v_id
      ) h ORDER BY created_at DESC,id LIMIT v_limit OFFSET v_offset
    ) x),'[]'::jsonb);
  END IF;

  IF p_action NOT IN ('product.save','inventory.adjust','customer.save','supplier.save') THEN
    RAISE EXCEPTION 'UNKNOWN_OPERATION' USING ERRCODE='22023';
  END IF;
  IF v_role='cashier' AND p_action<>'customer.save' THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  v_response := pos.begin_request(v_actor,'catalog.'||p_action,p_key,p_data);
  IF v_response IS NOT NULL THEN RETURN v_response; END IF;
  v_id := coalesce((p_data->>'id')::uuid,gen_random_uuid());
  IF p_action IN ('product.save','customer.save','supplier.save') THEN
    IF jsonb_typeof(p_data->'name') IS DISTINCT FROM 'string' OR length(btrim(p_data->>'name')) NOT BETWEEN 1 AND 160
      OR (p_data ? 'email' AND jsonb_typeof(p_data->'email') IS DISTINCT FROM 'string')
      OR (p_data ? 'phone' AND jsonb_typeof(p_data->'phone') IS DISTINCT FROM 'string')
      OR length(coalesce(p_data->>'email',''))>160 OR length(coalesce(p_data->>'phone',''))>40
      OR (coalesce(p_data->>'email','')<>'' AND (p_data->>'email') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') THEN
      RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023';
    END IF;
  END IF;
  IF p_action='product.save' THEN
    v_price := (p_data->>'price')::numeric;
    v_cost := (p_data->>'purchase_price')::numeric;
    PERFORM pos.require_amount(v_price);
    IF v_cost IS NOT NULL THEN PERFORM pos.require_amount(v_cost,true); END IF;
    IF jsonb_typeof(p_data->'sku') IS DISTINCT FROM 'string' OR length(btrim(p_data->>'sku')) NOT BETWEEN 1 AND 100
      OR coalesce((p_data->>'minimum')::integer,0) NOT BETWEEN 0 AND 1000000 THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
    v_supplier := (p_data->>'supplier_id')::uuid;
    IF v_supplier IS NOT NULL AND NOT EXISTS (SELECT FROM pos.suppliers WHERE id=v_supplier AND active) THEN
      RAISE EXCEPTION 'SUPPLIER_NOT_ACTIVE';
    END IF;
    IF p_data->>'id' IS NULL THEN
      INSERT INTO pos.products(id,sku,name,price,category,barcode,purchase_price,minimum,supplier_id,active)
        VALUES(v_id,btrim(p_data->>'sku'),btrim(p_data->>'name'),v_price,
          coalesce(nullif(btrim(p_data->>'category'),''),'Sin categoría'),nullif(btrim(p_data->>'barcode'),''),
          v_cost,coalesce((p_data->>'minimum')::integer,0),v_supplier,coalesce((p_data->>'active')::boolean,true));
      INSERT INTO pos.inventory_balances(product_id,quantity) VALUES(v_id,0);
    ELSE
      UPDATE pos.products SET sku=btrim(p_data->>'sku'),name=btrim(p_data->>'name'),price=v_price,
        category=coalesce(nullif(btrim(p_data->>'category'),''),'Sin categoría'),barcode=nullif(btrim(p_data->>'barcode'),''),
        purchase_price=v_cost,minimum=coalesce((p_data->>'minimum')::integer,0),supplier_id=v_supplier,
        active=coalesce((p_data->>'active')::boolean,true),version=version+1
        WHERE id=v_id AND version=(p_data->>'version')::integer;
      IF NOT FOUND THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    END IF;
  ELSIF p_action='inventory.adjust' THEN
    v_id := (p_data->>'product_id')::uuid;
    IF jsonb_typeof(p_data->'delta') IS DISTINCT FROM 'number'
      OR (p_data->>'delta')::numeric<>trunc((p_data->>'delta')::numeric)
      OR (p_data->>'delta')::numeric NOT BETWEEN -1000000 AND 1000000
      OR (p_data->>'delta')::numeric=0 OR p_data->>'reason' IS NULL
      OR length(btrim(p_data->>'reason')) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
    v_delta := (p_data->>'delta')::integer;
    -- Same product/balance lock order as confirm_sale; atomic stock update.
    PERFORM id FROM pos.products WHERE id=v_id AND active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_AVAILABLE'; END IF;
    UPDATE pos.inventory_balances SET quantity=quantity+v_delta
      WHERE product_id=v_id AND quantity::bigint+v_delta BETWEEN 0 AND 2147483647;
    IF NOT FOUND THEN RAISE EXCEPTION 'INSUFFICIENT_STOCK'; END IF;
    v_supplier := (p_data->>'supplier_id')::uuid;
    INSERT INTO pos.inventory_adjustments(product_id,supplier_id,quantity_delta,reason,created_by)
      VALUES(v_id,v_supplier,v_delta,btrim(p_data->>'reason'),v_actor);
  ELSIF p_action='customer.save' THEN
    IF p_data->>'id' IS NULL THEN
      INSERT INTO pos.customers(id,name,email,phone,active) VALUES(v_id,btrim(p_data->>'name'),coalesce(p_data->>'email',''),coalesce(p_data->>'phone',''),coalesce((p_data->>'active')::boolean,true));
    ELSE
      UPDATE pos.customers SET name=btrim(p_data->>'name'),email=coalesce(p_data->>'email',''),phone=coalesce(p_data->>'phone',''),
        active=coalesce((p_data->>'active')::boolean,true),version=version+1
        WHERE id=v_id AND version=(p_data->>'version')::integer;
      IF NOT FOUND THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    END IF;
  ELSIF p_action='supplier.save' THEN
    IF p_data->>'id' IS NULL THEN
      INSERT INTO pos.suppliers(id,name,email,phone,active) VALUES(v_id,btrim(p_data->>'name'),coalesce(p_data->>'email',''),coalesce(p_data->>'phone',''),coalesce((p_data->>'active')::boolean,true));
    ELSE
      UPDATE pos.suppliers SET name=btrim(p_data->>'name'),email=coalesce(p_data->>'email',''),phone=coalesce(p_data->>'phone',''),
        active=coalesce((p_data->>'active')::boolean,true),version=version+1
        WHERE id=v_id AND version=(p_data->>'version')::integer;
      IF NOT FOUND THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    END IF;
  END IF;
  INSERT INTO pos.audit_events(actor_id,action,entity_id) VALUES(v_actor,p_action,v_id);
  v_response := jsonb_build_object('id',v_id);
  INSERT INTO pos.idempotency_requests VALUES(v_actor,'catalog.'||p_action,p_key,p_data,v_response,pos.business_now());
  RETURN v_response;
END $$;
REVOKE ALL ON FUNCTION public.cai_catalog(text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,pos_app,pos_scheduler;
GRANT EXECUTE ON FUNCTION public.cai_catalog(text,jsonb,text) TO authenticated;
DO $$ BEGIN
  EXECUTE format('SET LOCAL ROLE %I',current_setting('cai.catalog_migration_role'));
END $$;
REVOKE CREATE ON SCHEMA pos, public FROM pos_owner;
NOTIFY pgrst,'reload schema';
COMMIT;
