-- V1.1. LOCAL ONLY: requires reviewed 001-008. Never apply without a verified
-- recoverable backup, independent rehearsal, and explicit production approval.
-- No ledger deletion, sequence reset, auth grants, or financial-owner transfer.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
DO $$ BEGIN
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='pos_owner' AND
    (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication))
    OR EXISTS(SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='pos_owner') THEN
    RAISE EXCEPTION 'UNSAFE_POS_OWNER';
  END IF;
  IF has_schema_privilege('pos_owner','pos','CREATE') OR has_schema_privilege('pos_owner','public','CREATE') THEN
    RAISE EXCEPTION 'REVIEW_OWNER_CREATE_PRIVILEGES';
  END IF;
  IF to_regprocedure('public.cai_report(jsonb)') IS NULL THEN RAISE EXCEPTION 'MIGRATION_008_REQUIRED'; END IF;
  -- 005's gateway bridge has a separate administrative owner. Preserve its
  -- narrow original ACL; pos_owner must not try to revoke as that owner.
  IF EXISTS(SELECT FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=to_regprocedure('pos.current_profile_auth_uid()')
      AND (a.grantee NOT IN (p.proowner,'pos_owner'::regrole)
        OR (a.grantee='pos_owner'::regrole AND a.is_grantable))) THEN
    RAISE EXCEPTION 'UNSAFE_AUTH_BRIDGE_ACL';
  END IF;
END $$;
GRANT CREATE ON SCHEMA pos,public TO pos_owner;
SELECT set_config('cai.v11_migration_role',current_user,true);
SET LOCAL ROLE pos_owner;

CREATE TABLE pos.operating_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opened_at timestamptz NOT NULL DEFAULT pos.business_now(),
  closed_at timestamptz,
  closed_by uuid REFERENCES pos.profiles(id),
  reason text,
  closing_snapshot jsonb,
  CHECK ((closed_at IS NULL AND closed_by IS NULL) OR
    (closed_at IS NOT NULL AND closed_by IS NOT NULL AND length(btrim(reason)) BETWEEN 5 AND 500))
);
INSERT INTO pos.operating_periods(id) VALUES('11111111-1111-4111-8111-111111111111');
CREATE TABLE pos.operation_state (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  period_id uuid NOT NULL REFERENCES pos.operating_periods(id),
  revision bigint NOT NULL DEFAULT 1
);
INSERT INTO pos.operation_state VALUES(true,'11111111-1111-4111-8111-111111111111',1);
CREATE UNIQUE INDEX one_active_operating_period ON pos.operating_periods((true)) WHERE closed_at IS NULL;

CREATE FUNCTION pos.current_period() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pos,pg_temp AS $$ SELECT period_id FROM pos.operation_state WHERE id $$;
CREATE FUNCTION pos.read_period() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pos,pg_temp AS $$
  SELECT coalesce(nullif(current_setting('cai.archive_period',true),'')::uuid,pos.current_period())
$$;
CREATE FUNCTION pos.operation_guard(p_expected uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE v_period uuid;
BEGIN
  PERFORM pos.require_read_committed();
  BEGIN SELECT period_id INTO v_period FROM pos.operation_state WHERE id FOR SHARE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'OPERATION_IN_PROGRESS' USING ERRCODE='55P03'; END;
  IF p_expected IS NOT NULL AND p_expected<>v_period THEN RAISE EXCEPTION 'PERIOD_CHANGED'; END IF;
  RETURN v_period;
END $$;
CREATE FUNCTION pos.guard_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pos,pg_temp AS $$ BEGIN PERFORM pos.operation_guard(); RETURN NULL; END $$;

-- Metadata-only constant default labels every existing row without UPDATE of
-- immutable ledgers. New rows use the active period. PG12+ supports this path.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sales','sale_items','payments','inventory_movements','cash_entries',
    'cash_sessions','credit_accounts','credit_limit_authorizations','credit_charges','credit_receipts',
    'credit_allocations','sale_returns','cash_adjustments','cash_closings','inventory_adjustments',
    'inventory_balances','credit_reminders','reminder_attempts','reminder_delivery_events'] LOOP
    EXECUTE format('ALTER TABLE pos.%I ADD COLUMN operating_period_id uuid NOT NULL DEFAULT %L::uuid REFERENCES pos.operating_periods(id)',t,'11111111-1111-4111-8111-111111111111');
    EXECUTE format('ALTER TABLE pos.%I ALTER COLUMN operating_period_id SET DEFAULT pos.current_period()',t);
    EXECUTE format('CREATE INDEX %I ON pos.%I(operating_period_id)',t||'_period_idx',t);
    EXECUTE format('ALTER TABLE pos.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY active_period_read ON pos.%I FOR SELECT TO pos_owner USING(operating_period_id=pos.read_period())',t);
    EXECUTE format('CREATE POLICY active_period_insert ON pos.%I FOR INSERT TO pos_owner WITH CHECK(operating_period_id=pos.current_period())',t);
    EXECUTE format('CREATE POLICY active_period_update ON pos.%I FOR UPDATE TO pos_owner USING(operating_period_id=pos.current_period()) WITH CHECK(operating_period_id=pos.current_period())',t);
  END LOOP;
  -- A statement trigger is defense in depth, including scheduler paths and
  -- zero-row writes. Public entry points acquire the guard BEFORE other locks.
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='pos'
    AND tablename NOT IN ('operation_state','operating_periods') LOOP
    EXECUTE format('CREATE TRIGGER v11_write_gate BEFORE INSERT OR UPDATE OR DELETE ON pos.%I FOR EACH STATEMENT EXECUTE FUNCTION pos.guard_write()',t);
  END LOOP;
END $$;
ALTER TABLE pos.inventory_balances DROP CONSTRAINT inventory_balances_pkey,
  ADD PRIMARY KEY(product_id,operating_period_id);
ALTER TABLE pos.credit_accounts DROP CONSTRAINT credit_accounts_customer_id_key,
  ADD UNIQUE(customer_id,operating_period_id);

-- Links must remain within one period. Referential-integrity FK checks bypass
-- RLS internally; this explicit check closes that otherwise subtle archive path.
CREATE FUNCTION pos.check_period_links() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE v_col text; v_table text; v_id uuid; v_found boolean;
BEGIN
  FOR v_col,v_table IN SELECT * FROM (VALUES
    ('sale_id','sales'),('cash_session_id','cash_sessions'),('session_id','cash_sessions'),
    ('account_id','credit_accounts'),('receipt_id','credit_receipts'),('charge_id','credit_charges'),
    ('payment_id','payments'),('return_id','sale_returns'),('reminder_id','credit_reminders')) x(c,t)
  LOOP
    IF to_jsonb(NEW) ? v_col AND to_jsonb(NEW)->>v_col IS NOT NULL
      AND NOT (TG_TABLE_NAME='credit_limit_authorizations' AND v_col='sale_id') THEN
      v_id := (to_jsonb(NEW)->>v_col)::uuid;
      EXECUTE format('SELECT EXISTS(SELECT FROM pos.%I WHERE id=$1 AND operating_period_id=$2)',v_table)
        INTO v_found USING v_id,NEW.operating_period_id;
      IF NOT v_found THEN RAISE EXCEPTION 'CROSS_PERIOD_REFERENCE'; END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c
    WHERE c.table_schema='pos' AND c.column_name='operating_period_id' LOOP
    EXECUTE format('CREATE TRIGGER v11_period_links BEFORE INSERT OR UPDATE ON pos.%I FOR EACH ROW EXECUTE FUNCTION pos.check_period_links()',t);
  END LOOP;
END $$;

ALTER TABLE pos.sales ADD COLUMN buyer_name text NOT NULL DEFAULT 'Consumidor final'
  CHECK(length(btrim(buyer_name)) BETWEEN 1 AND 160);
ALTER TABLE pos.products ADD COLUMN image_id uuid;
ALTER TABLE pos.credit_charges ALTER COLUMN due_on DROP NOT NULL,
  DROP CONSTRAINT credit_charges_due_policy,
  ADD CONSTRAINT credit_charges_due_policy CHECK(due_on IS NULL OR (isfinite(due_on) AND due_on>=purchased_on));
-- A seller may authorize financing for THIS sale. This is an immutable, exact
-- per-sale authorization, never a client-chosen general credit-limit change.
ALTER TABLE pos.credit_limit_authorizations
  ADD COLUMN scope text NOT NULL DEFAULT 'manual' CHECK(scope IN ('manual','sale')),
  ADD COLUMN sale_id uuid UNIQUE REFERENCES pos.sales(id) DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN financed_amount numeric(18,2),
  ADD CHECK((scope='manual' AND sale_id IS NULL AND financed_amount IS NULL) OR
    (scope='sale' AND sale_id IS NOT NULL AND financed_amount>0 AND new_limit=previous_limit+financed_amount));

CREATE TABLE pos.product_media (
  image_id uuid PRIMARY KEY, product_id uuid NOT NULL REFERENCES pos.products(id),
  object_key text NOT NULL UNIQUE, mime text NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp')),
  size integer NOT NULL CHECK(size BETWEEN 1 AND 2097152),
  width integer NOT NULL CHECK(width BETWEEN 1 AND 4096), height integer NOT NULL CHECK(height BETWEEN 1 AND 4096),
  etag text NOT NULL CHECK(length(etag) BETWEEN 1 AND 100),
  created_by uuid NOT NULL REFERENCES pos.profiles(id), created_at timestamptz NOT NULL DEFAULT pos.business_now(),
  CHECK(object_key='products/'||product_id::text||'/'||image_id::text)
);
ALTER TABLE pos.products ADD FOREIGN KEY(image_id) REFERENCES pos.product_media(image_id);
CREATE TABLE pos.reset_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES pos.profiles(id),
  session_id uuid NOT NULL, period_id uuid NOT NULL REFERENCES pos.operating_periods(id),
  snapshot jsonb NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['operating_periods','operation_state','product_media','reset_intents'] LOOP
    EXECUTE format('ALTER TABLE pos.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON pos.%I FROM PUBLIC,anon,authenticated,service_role,pos_app,pos_scheduler',t);
  END LOOP;
END $$;
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON pos.product_media
  FOR EACH ROW EXECUTE FUNCTION pos.prevent_financial_mutation();

-- Preserve the gateway validation; fail closed for retained Supervisor profiles
-- until an administrator explicitly assigns admin/cashier.
CREATE OR REPLACE FUNCTION pos.require_staff(p_actor uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE v_role text;
BEGIN
  PERFORM pos.require_read_committed();
  PERFORM pos.operation_guard();
  IF session_user<>'authenticator' OR coalesce(current_setting('request.jwt.claims',true),'')='' THEN
    RAISE EXCEPTION 'UNTRUSTED_AUTH_CONTEXT' USING ERRCODE='42501'; END IF;
  IF (current_setting('request.jwt.claims',true)::jsonb->>'role') IS DISTINCT FROM 'authenticated'
    OR p_actor IS NULL OR (current_setting('request.jwt.claims',true)::jsonb->>'sub')::uuid IS DISTINCT FROM p_actor
    OR coalesce((current_setting('request.jwt.claims',true)::jsonb->>'exp')::numeric,0)<=extract(epoch FROM clock_timestamp()) THEN
    RAISE EXCEPTION 'FORBIDDEN_ACTOR' USING ERRCODE='42501'; END IF;
  SELECT role INTO v_role FROM pos.profiles WHERE id=p_actor AND active FOR SHARE;
  IF v_role IS NULL OR v_role NOT IN ('admin','cashier') THEN RAISE EXCEPTION 'ROLE_RECLASSIFICATION_REQUIRED' USING ERRCODE='42501'; END IF;
  RETURN v_role;
END $$;

-- Legacy implementations are private, ungranted helpers. Every Data API entry
-- point below has independent authorization; bypassing the Worker grants nothing.
ALTER FUNCTION public.cai_catalog(text,jsonb,text) SET SCHEMA pos;
ALTER FUNCTION pos.cai_catalog(text,jsonb,text) RENAME TO catalog_v1;
ALTER FUNCTION public.cai_operations(text,jsonb,text) SET SCHEMA pos;
ALTER FUNCTION pos.cai_operations(text,jsonb,text) RENAME TO operations_v1;
ALTER FUNCTION public.cai_report(jsonb) SET SCHEMA pos;
ALTER FUNCTION pos.cai_report(jsonb) RENAME TO report_v1;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='pos' AND p.oid<>'pos.current_profile_auth_uid()'::regprocedure LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,pos_app',r.signature);
  END LOOP;
END $$;
-- Scheduler entry points remain specifically granted; tables stay inaccessible.

CREATE FUNCTION pos.require_period(p_data jsonb) RETURNS uuid LANGUAGE plpgsql
SET search_path=pg_catalog,pos,pg_temp AS $$
BEGIN
  IF p_data->>'expected_period' IS NULL THEN RAISE EXCEPTION 'PERIOD_REQUIRED'; END IF;
  RETURN pos.operation_guard((p_data->>'expected_period')::uuid);
END $$;

CREATE FUNCTION public.cai_catalog(p_action text,p_data jsonb DEFAULT '{}',p_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE v_actor uuid; v_role text; v_result jsonb; v_data jsonb; v_product pos.products;
  v_id uuid; v_stock integer; v_quantity numeric; v_delta integer; v_image uuid;
BEGIN
  v_actor:=pos.current_profile_auth_uid(); v_role:=pos.require_staff(v_actor);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR octet_length(p_data::text)>32768 THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
  IF v_role<>'admin' AND p_action NOT IN ('products.list','media.read','customers.search') THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_action='customers.search' THEN
    IF length(coalesce(p_data->>'search',''))>100 OR coalesce((p_data->>'limit')::integer,20) NOT BETWEEN 1 AND 100
      OR coalesce((p_data->>'offset')::integer,0) NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('customers',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
      SELECT id,name,phone,active,version FROM pos.customers WHERE active AND
        (name ILIKE '%'||coalesce(p_data->>'search','')||'%' OR phone ILIKE '%'||coalesce(p_data->>'search','')||'%')
      ORDER BY name,id LIMIT coalesce((p_data->>'limit')::integer,20) OFFSET coalesce((p_data->>'offset')::integer,0)
    ) x),'[]'::jsonb));
  END IF;
  IF p_action IN ('products.list','directories.list','inventory.history') THEN
    v_result:=pos.catalog_v1(p_action,p_data,p_key);
    IF p_action='products.list' THEN
      SELECT jsonb_set(v_result,'{rows}',coalesce(jsonb_agg(
        CASE WHEN v_role='cashier' THEN x-'purchase_price'-'supplier_id'-'category'-'barcode'-'sku' ELSE x END
        ||jsonb_build_object('image_id',(SELECT image_id FROM pos.products WHERE id=(x->>'id')::uuid))
      ),'[]'::jsonb)) INTO v_result FROM jsonb_array_elements(v_result->'rows') x;
    END IF;
    RETURN v_result;
  ELSIF p_action='media.read' THEN
    SELECT jsonb_build_object('image_id',m.image_id,'object_key',m.object_key,'mime',m.mime,'size',m.size,'etag',m.etag)
      INTO v_result FROM pos.products p JOIN pos.product_media m ON m.image_id=p.image_id
      WHERE p.id=(p_data->>'product_id')::uuid AND (v_role='admin' OR p.active);
    RETURN v_result;
  END IF;
  IF p_action NOT IN ('product.save','inventory.adjust','customer.save','supplier.save','media.attach') THEN RAISE EXCEPTION 'UNKNOWN_OPERATION' USING ERRCODE='22023'; END IF;
  PERFORM pos.require_period(p_data);
  v_result:=pos.begin_request(v_actor,'v11.catalog.'||p_action,p_key,p_data);
  IF v_result IS NOT NULL THEN RETURN v_result; END IF;
  IF p_action='product.save' THEN
    v_data:=p_data;
    IF p_data->>'id' IS NOT NULL THEN
      SELECT * INTO v_product FROM pos.products WHERE id=(p_data->>'id')::uuid FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_AVAILABLE'; END IF;
      v_data:=jsonb_build_object('sku',v_product.sku,'category',v_product.category,'barcode',v_product.barcode,
        'supplier_id',v_product.supplier_id,'active',v_product.active)||p_data;
      SELECT quantity INTO v_stock FROM pos.inventory_balances WHERE product_id=v_product.id FOR UPDATE;
    ELSE
      v_data:=jsonb_build_object('sku','CAI-'||gen_random_uuid()::text)||p_data;
      v_stock:=0;
    END IF;
    IF p_data ? 'quantity' THEN
      v_quantity:=(p_data->>'quantity')::numeric;
      IF v_quantity IS NULL OR v_quantity NOT BETWEEN 0 AND 1000000 OR v_quantity<>trunc(v_quantity) THEN RAISE EXCEPTION 'INVALID_QUANTITY'; END IF;
      IF (p_data->>'expected_stock')::integer IS DISTINCT FROM v_stock THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    END IF;
    v_result:=pos.catalog_v1(p_action,v_data,p_key);
    v_id:=(v_result->>'id')::uuid;
    IF p_data ? 'quantity' THEN
      v_delta:=v_quantity::integer-v_stock;
      IF v_delta<>0 THEN
        UPDATE pos.inventory_balances SET quantity=v_quantity::integer WHERE product_id=v_id;
        INSERT INTO pos.inventory_adjustments(product_id,quantity_delta,reason,created_by)
          VALUES(v_id,v_delta,'Conteo confirmado en formulario de producto',v_actor);
      END IF;
    END IF;
  ELSIF p_action='media.attach' THEN
    IF NOT (p_data ? 'expected_image_id') THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    SELECT * INTO v_product FROM pos.products WHERE id=(p_data->>'product_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_AVAILABLE'; END IF;
    IF v_product.image_id IS DISTINCT FROM (p_data->>'expected_image_id')::uuid THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
    v_image:=(p_data->>'image_id')::uuid;
    INSERT INTO pos.product_media(image_id,product_id,object_key,mime,size,width,height,etag,created_by)
      VALUES(v_image,v_product.id,p_data->>'object_key',p_data->>'mime',(p_data->>'size')::integer,
        (p_data->>'width')::integer,(p_data->>'height')::integer,p_data->>'etag',v_actor);
    UPDATE pos.products SET image_id=v_image,version=version+1 WHERE id=v_product.id;
    INSERT INTO pos.audit_events(actor_id,action,entity_id,details) VALUES(v_actor,'product.image_attached',v_product.id,jsonb_build_object('image_id',v_image));
    v_result:=jsonb_build_object('image_id',v_image);
  ELSE v_result:=pos.catalog_v1(p_action,p_data,p_key);
  END IF;
  INSERT INTO pos.idempotency_requests VALUES(v_actor,'v11.catalog.'||p_action,p_key,p_data,v_result,pos.business_now());
  RETURN v_result;
END $$;

-- The remaining functions are installed below in the same atomic transaction.

CREATE FUNCTION pos.confirm_sale_v11(p_actor uuid, p_customer uuid, p_session uuid, p_lines jsonb, p_payments jsonb, p_finance_remainder boolean, p_key text, p_buyer text, p_due date, p_expected_total numeric) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_account uuid; v_sale uuid := gen_random_uuid(); v_charge uuid; v_payment uuid;
  v_total numeric := 0; v_paid numeric := 0; v_financed numeric; v_available numeric; v_amount numeric;
  v_method pos.payment_methods; v_line jsonb; v_lines jsonb; v_item record; v_due date;
  v_now timestamptz; v_response jsonb; v_authorization_id bigint;
  v_request jsonb := jsonb_build_object('customer', p_customer, 'session', p_session, 'lines', p_lines, 'payments', p_payments, 'finance', p_finance_remainder, 'buyer', p_buyer, 'due', p_due, 'expected_total', p_expected_total);
BEGIN
  PERFORM pos.require_staff(p_actor);
  v_response := pos.begin_request(p_actor, 'sale.v11', p_key, v_request);
  IF v_response IS NOT NULL THEN RETURN v_response; END IF;
  IF p_finance_remainder IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_payments) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_SALE'; END IF;
  IF jsonb_array_length(p_lines) NOT BETWEEN 1 AND 100 OR jsonb_array_length(p_payments) > 10 THEN RAISE EXCEPTION 'INVALID_SALE'; END IF;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    IF jsonb_typeof(v_line->'quantity') IS DISTINCT FROM 'number'
      OR (v_line->>'quantity')::numeric NOT BETWEEN 1 AND 1000000
      OR (v_line->>'quantity')::numeric <> trunc((v_line->>'quantity')::numeric)
      OR v_line->>'product_id' IS NULL THEN RAISE EXCEPTION 'INVALID_QUANTITY'; END IF;
  END LOOP;
  SELECT jsonb_agg(jsonb_build_object('product_id', product_id, 'quantity', quantity) ORDER BY product_id) INTO v_lines
  FROM (SELECT (value->>'product_id')::uuid product_id, sum((value->>'quantity')::integer)::integer quantity
    FROM jsonb_array_elements(p_lines) GROUP BY (value->>'product_id')::uuid) q;

  IF p_customer IS NOT NULL AND NOT EXISTS (SELECT FROM pos.customers WHERE id = p_customer AND active) THEN RAISE EXCEPTION 'CUSTOMER_NOT_ACTIVE'; END IF;
  IF p_finance_remainder THEN
    IF p_customer IS NULL THEN RAISE EXCEPTION 'CREDIT_CUSTOMER_REQUIRED'; END IF;
    INSERT INTO pos.credit_accounts(customer_id) VALUES(p_customer) ON CONFLICT(customer_id,operating_period_id) DO NOTHING;
    SELECT id INTO v_account FROM pos.credit_accounts WHERE customer_id = p_customer AND active FOR UPDATE;
    IF v_account IS NULL THEN RAISE EXCEPTION 'CREDIT_ACCOUNT_REQUIRED'; END IF;
  END IF;
  PERFORM pos.lock_cash_session(p_actor, p_session);
  PERFORM p.id FROM pos.products p JOIN jsonb_to_recordset(v_lines) x(product_id uuid, quantity integer) ON p.id = x.product_id ORDER BY p.id FOR SHARE OF p;
  PERFORM b.product_id FROM pos.inventory_balances b JOIN jsonb_to_recordset(v_lines) x(product_id uuid, quantity integer) ON b.product_id = x.product_id ORDER BY b.product_id FOR UPDATE OF b;
  FOR v_item IN SELECT x.*, p.name, p.price, p.active, b.quantity AS stock FROM jsonb_to_recordset(v_lines) x(product_id uuid, quantity integer)
    LEFT JOIN pos.products p ON p.id = x.product_id LEFT JOIN pos.inventory_balances b ON b.product_id = x.product_id ORDER BY x.product_id LOOP
    IF v_item.active IS DISTINCT FROM true OR v_item.stock IS NULL THEN RAISE EXCEPTION 'PRODUCT_NOT_AVAILABLE'; END IF;
    IF v_item.quantity > v_item.stock THEN RAISE EXCEPTION 'INSUFFICIENT_STOCK'; END IF;
    v_total := v_total + v_item.price * v_item.quantity;
  END LOOP;
  PERFORM pos.require_amount(v_total);
  IF p_expected_total IS DISTINCT FROM v_total THEN RAISE EXCEPTION 'PRICE_CHANGED'; END IF;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
    v_amount := (v_line->>'amount')::numeric;
    PERFORM pos.require_amount(v_amount);
    SELECT * INTO v_method FROM pos.payment_methods WHERE id = (v_line->>'method_id')::uuid AND active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_PAYMENT_METHOD'; END IF;
    IF v_method.requires_reference AND nullif(btrim(v_line->>'reference'), '') IS NULL THEN RAISE EXCEPTION 'PAYMENT_REFERENCE_REQUIRED'; END IF;
    v_paid := v_paid + v_amount;
  END LOOP;
  IF v_paid > v_total THEN RAISE EXCEPTION 'PAYMENT_EXCEEDS_TOTAL'; END IF;
  v_financed := v_total - v_paid;
  v_now := pos.business_now();
  IF v_financed > 0 THEN
    IF NOT p_finance_remainder THEN RAISE EXCEPTION 'PAYMENTS_DO_NOT_MATCH'; END IF;
    v_due := p_due;
    IF v_due IS NOT NULL AND (NOT isfinite(v_due) OR v_due<(v_now AT TIME ZONE 'America/Bogota')::date) THEN RAISE EXCEPTION 'INVALID_DUE_DATE'; END IF;
    -- Increase only by the financed principal for this server-priced sale.
    -- The deferred FK binds the authorization to the newly inserted sale.
    SELECT authorized_limit INTO v_available FROM pos.credit_account_balances WHERE id=v_account;
    INSERT INTO pos.credit_limit_authorizations(account_id,previous_limit,new_limit,reason,authorized_by,scope,sale_id,financed_amount)
      VALUES(v_account,v_available,v_available+v_financed,'Financiación de venta autorizada por el vendedor',p_actor,'sale',v_sale,v_financed);

    SELECT available, authorization_id INTO v_available, v_authorization_id FROM pos.credit_account_balances WHERE id = v_account;
    IF v_financed > v_available THEN RAISE EXCEPTION 'CREDIT_LIMIT_EXCEEDED'; END IF;
  END IF;
  INSERT INTO pos.sales(id, customer_id, cash_session_id, created_by, created_at, total,buyer_name) VALUES(v_sale,p_customer,p_session,p_actor,v_now,v_total,coalesce(nullif(btrim(p_buyer),''),'Consumidor final'));
  FOR v_item IN SELECT x.*, p.name, p.price FROM jsonb_to_recordset(v_lines) x(product_id uuid, quantity integer) JOIN pos.products p ON p.id = x.product_id LOOP
    INSERT INTO pos.sale_items(sale_id, product_id, name_snapshot, quantity, unit_price, total) VALUES(v_sale, v_item.product_id, v_item.name, v_item.quantity, v_item.price, v_item.quantity * v_item.price);
    UPDATE pos.inventory_balances SET quantity = quantity - v_item.quantity WHERE product_id = v_item.product_id;
    INSERT INTO pos.inventory_movements(sale_id, product_id, quantity_delta, created_by, created_at) VALUES(v_sale, v_item.product_id, -v_item.quantity, p_actor, v_now);
  END LOOP;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
    SELECT * INTO v_method FROM pos.payment_methods WHERE id = (v_line->>'method_id')::uuid;
    INSERT INTO pos.payments(sale_id, method_id, amount, reference, affects_cash_snapshot) VALUES(v_sale, v_method.id, (v_line->>'amount')::numeric, v_line->>'reference', v_method.affects_cash) RETURNING id INTO v_payment;
    IF v_method.affects_cash THEN
      INSERT INTO pos.cash_entries(session_id, payment_id, amount, created_by) VALUES(p_session, v_payment, (v_line->>'amount')::numeric, p_actor);
    END IF;
  END LOOP;
  IF v_financed > 0 THEN
    INSERT INTO pos.credit_charges(account_id, customer_id, sale_id, principal, authorization_id, purchased_on, due_on, created_at)
      VALUES(v_account, p_customer, v_sale, v_financed, v_authorization_id, (v_now AT TIME ZONE 'America/Bogota')::date, v_due, v_now) RETURNING id INTO v_charge;
  END IF;
  INSERT INTO pos.audit_events(actor_id, action, entity_id, details) VALUES(p_actor, 'sale.confirmed', v_sale, jsonb_build_object('total', v_total, 'received', v_paid, 'financed', v_financed));
  v_response := jsonb_build_object('sale_id', v_sale, 'charge_id', v_charge, 'total', v_total::text, 'received', v_paid::text, 'financed', v_financed::text, 'due_on', v_due);
  INSERT INTO pos.idempotency_requests VALUES(p_actor, 'sale.v11', p_key, v_request, v_response, pos.business_now());
  RETURN v_response;
END $$;


CREATE FUNCTION pos.valid_credit_phone(p_phone text) RETURNS boolean LANGUAGE sql IMMUTABLE
SET search_path=pg_catalog AS $$
  SELECT coalesce(length(btrim(p_phone)) BETWEEN 7 AND 40
    AND btrim(p_phone) ~ '^\+?[0-9() .-]+$'
    AND length(regexp_replace(p_phone,'[^0-9]','','g')) BETWEEN 7 AND 15,false)
$$;

CREATE FUNCTION pos.debt_row(p_charge uuid) RETURNS jsonb LANGUAGE sql STABLE
SET search_path=pg_catalog,pos,pg_temp AS $$
  SELECT jsonb_build_object('id',b.id,'charge_id',b.id,'sale_id',b.sale_id,'customer_id',b.customer_id,
    'name',c.name,'phone',c.phone,'purchased_on',b.purchased_on,'due_on',b.due_on,
    'returned',EXISTS(SELECT FROM pos.sale_returns WHERE sale_id=s.id),
    'return_credit_reduction',coalesce((SELECT credit_reduction::text FROM pos.sale_returns WHERE sale_id=s.id),'0'),
    'refund_amount',coalesce((SELECT refund_amount::text FROM pos.sale_returns WHERE sale_id=s.id),'0'),
    'total',s.total::text,'initial_payment',(s.total-b.principal)::text,'principal',b.principal::text,
    'paid',((s.total-b.principal)+coalesce((SELECT sum(amount) FROM pos.credit_allocations WHERE charge_id=b.id),0))::text,
    'outstanding',b.outstanding::text,'status',CASE WHEN b.status='active' THEN 'pending' ELSE b.status END,
    'products',coalesce((SELECT jsonb_agg(jsonb_build_object('name',name_snapshot,'quantity',quantity,
      'unit_price',unit_price::text,'total',total::text) ORDER BY id) FROM pos.sale_items WHERE sale_id=b.sale_id),'[]'::jsonb))
  FROM pos.credit_charge_balances b JOIN pos.customers c ON c.id=b.customer_id JOIN pos.sales s ON s.id=b.sale_id WHERE b.id=p_charge
$$;

CREATE FUNCTION pos.period_snapshot() RETURNS jsonb LANGUAGE sql STABLE
SET search_path=pg_catalog,pos,pg_temp AS $$
  SELECT jsonb_build_object('period_id',pos.current_period(),'sales',(SELECT count(*) FROM pos.sales),
    'sales_total',(SELECT coalesce(sum(total),0)::text FROM pos.sales),
    'debts',(SELECT count(*) FROM pos.credit_charges),'outstanding',(SELECT coalesce(sum(outstanding),0)::text FROM pos.credit_charge_balances),
    'receipts',(SELECT count(*) FROM pos.credit_receipts),'receipt_total',(SELECT coalesce(sum(amount),0)::text FROM pos.credit_receipts),
    'stock',(SELECT coalesce(sum(quantity),0) FROM pos.inventory_balances),
    'inventory_fingerprint',(SELECT md5(coalesce(string_agg(product_id::text||':'||quantity::text,',' ORDER BY product_id),'')) FROM pos.inventory_balances),
    'audit_revision',(SELECT coalesce(max(id),0) FROM pos.audit_events),
    'product_fingerprint',(SELECT md5(coalesce(string_agg(id::text||':'||version::text,',' ORDER BY id),'')) FROM pos.products),
    'open_sessions',(SELECT count(*) FROM pos.cash_sessions WHERE closed_at IS NULL))
$$;
CREATE FUNCTION pos.require_recent_auth() RETURNS uuid LANGUAGE plpgsql
SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE v_claims jsonb; v_session uuid; v_recent boolean;
BEGIN
  -- require_staff already verifies the PostgREST gateway, subject, role, and exp.
  PERFORM pos.require_staff(pos.current_profile_auth_uid());
  v_claims:=current_setting('request.jwt.claims',true)::jsonb;
  v_session:=nullif(v_claims->>'session_id','')::uuid;
  IF v_session IS NULL OR jsonb_typeof(v_claims->'amr') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'RECENT_AUTH_REQUIRED' USING ERRCODE='42501'; END IF;
  SELECT coalesce(bool_or(x->>'method' IN ('password','totp','webauthn','otp','oauth')
    AND jsonb_typeof(x->'timestamp')='number' AND (x->>'timestamp')::numeric=trunc((x->>'timestamp')::numeric)
    AND (x->>'timestamp')::numeric BETWEEN extract(epoch FROM clock_timestamp())-300 AND extract(epoch FROM clock_timestamp())+5),false)
    INTO v_recent FROM jsonb_array_elements(v_claims->'amr') x;
  IF NOT v_recent THEN RAISE EXCEPTION 'RECENT_AUTH_REQUIRED' USING ERRCODE='42501'; END IF;
  RETURN v_session;
END $$;

CREATE FUNCTION public.cai_operations(p_action text,p_data jsonb DEFAULT '{}',p_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE v_actor uuid; v_role text; v_period uuid; v_response jsonb; v_data jsonb; v_customer uuid;
  v_charge pos.credit_charges; v_account uuid; v_amount numeric; v_debt numeric; v_method pos.payment_methods;
  v_receipt uuid; v_intent pos.reset_intents; v_session uuid; v_new uuid; v_snapshot jsonb;
  v_limit integer; v_offset integer; v_status text; v_search text; v_id uuid;
BEGIN
  v_actor:=pos.current_profile_auth_uid(); v_role:=pos.require_staff(v_actor);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR octet_length(p_data::text)>32768 THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
  IF v_role='cashier' AND p_action NOT IN ('bootstrap','cash.list','cash.entries','cash.open','cash.close',
    'sales.list','sales.detail','sale.confirm','debts.list','debt.detail','debt.receipt') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  v_period:=pos.current_period();
  IF p_action='bootstrap' THEN
    v_response:=pos.operations_v1(p_action,p_data,p_key);
    RETURN v_response||jsonb_build_object('period_id',v_period,
      'permissions',jsonb_build_object('credit',true,'expenses',v_role='admin'));
  ELSIF p_action='debts.list' THEN
    v_limit:=coalesce((p_data->>'limit')::integer,20); v_offset:=coalesce((p_data->>'offset')::integer,0);
    v_status:=coalesce(p_data->>'status','all'); v_search:=coalesce(p_data->>'search','');
    IF v_limit NOT BETWEEN 1 AND 100 OR v_offset NOT BETWEEN 0 AND 100000 OR length(v_search)>100
      OR v_status NOT IN ('pending','overdue','paid','all') THEN RAISE EXCEPTION 'INVALID_FILTER' USING ERRCODE='22023'; END IF;
    WITH filtered AS (SELECT b.id,b.purchased_on FROM pos.credit_charge_balances b JOIN pos.customers c ON c.id=b.customer_id
      WHERE (v_status='all' OR CASE WHEN b.status='active' THEN 'pending' ELSE b.status END=v_status)
        AND (c.name ILIKE '%'||v_search||'%' OR c.phone ILIKE '%'||v_search||'%'))
    SELECT jsonb_build_object('total',(SELECT count(*) FROM filtered),'rows',coalesce((SELECT jsonb_agg(pos.debt_row(x.id))
      FROM (SELECT * FROM filtered ORDER BY purchased_on DESC,id LIMIT v_limit OFFSET v_offset) x),'[]'::jsonb)) INTO v_response;
    RETURN v_response;
  ELSIF p_action='debt.detail' THEN
    v_id:=(p_data->>'charge_id')::uuid;
    v_response:=pos.debt_row(v_id);
    IF v_response IS NULL THEN RAISE EXCEPTION 'DEBT_NOT_FOUND'; END IF;
    RETURN v_response||jsonb_build_object('receipts',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY received_at,id) FROM (
      SELECT r.id,a.amount::text,r.received_at,m.name AS method,r.reference,'receipt'::text AS kind
        FROM pos.credit_allocations a JOIN pos.credit_receipts r ON r.id=a.receipt_id JOIN pos.payment_methods m ON m.id=r.method_id WHERE a.charge_id=v_id
      UNION ALL SELECT p.id,p.amount::text,p.created_at,m.name,p.reference,'initial_payment'
        FROM pos.payments p JOIN pos.payment_methods m ON m.id=p.method_id WHERE p.sale_id=(v_response->>'sale_id')::uuid
    ) x),'[]'::jsonb));
  ELSIF p_action='reset.preview' THEN
    -- A preview intent binds the explicit confirmation to a snapshot and session.
    PERFORM pos.require_period(p_data);
    v_session:=pos.require_recent_auth();
    v_snapshot:=pos.period_snapshot();
    INSERT INTO pos.reset_intents(actor_id,session_id,period_id,snapshot,expires_at)
      VALUES(v_actor,v_session,v_period,v_snapshot,clock_timestamp()+interval '5 minutes') RETURNING * INTO v_intent;
    RETURN v_snapshot||jsonb_build_object('intent_id',v_intent.id,'expires_at',v_intent.expires_at);
  ELSIF p_action='periods.list' THEN
    RETURN coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY opened_at DESC,id) FROM (
      SELECT id,opened_at,closed_at,closed_by,reason,closing_snapshot FROM pos.operating_periods
    ) x),'[]'::jsonb);
  ELSIF p_action='periods.detail' THEN
    v_limit:=coalesce((p_data->>'limit')::integer,100); v_offset:=coalesce((p_data->>'offset')::integer,0);
    IF v_limit NOT BETWEEN 1 AND 100 OR v_offset NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'INVALID_PAGINATION' USING ERRCODE='22023'; END IF;
    v_id:=(p_data->>'period_id')::uuid;
    IF NOT EXISTS(SELECT FROM pos.operating_periods WHERE id=v_id AND closed_at IS NOT NULL) THEN RAISE EXCEPTION 'ARCHIVED_PERIOD_REQUIRED'; END IF;
    -- This GUC is set exclusively inside this validated admin-only entry point.
    -- No RPC exposes set_config or accepts arbitrary SQL. WITH CHECK stays active.
    PERFORM set_config('cai.archive_period',v_id::text,true);
    SELECT jsonb_build_object('period_id',v_id,'totals',jsonb_build_object('sales',(SELECT count(*) FROM pos.sales),'debts',(SELECT count(*) FROM pos.credit_charges),'stock',(SELECT count(*) FROM pos.inventory_balances)),'sales',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM
      (SELECT id,number,buyer_name,total::text,created_at FROM pos.sales ORDER BY number LIMIT v_limit OFFSET v_offset) x),'[]'::jsonb),
      'debts',coalesce((SELECT jsonb_agg(pos.debt_row(id)) FROM
      (SELECT id FROM pos.credit_charges ORDER BY created_at,id LIMIT v_limit OFFSET v_offset) x),'[]'::jsonb),
      'stock',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM
      (SELECT product_id,quantity FROM pos.inventory_balances ORDER BY product_id LIMIT v_limit OFFSET v_offset) x),'[]'::jsonb)) INTO v_response;
    PERFORM set_config('cai.archive_period','',true);
    RETURN v_response;
  ELSIF p_action='sales.list' THEN
    v_response:=pos.operations_v1(p_action,p_data,p_key);
    RETURN jsonb_set(v_response,'{rows}',coalesce((SELECT jsonb_agg(x||jsonb_build_object('customer',
      coalesce(x->>'customer',(SELECT buyer_name FROM pos.sales WHERE id=(x->>'id')::uuid))))
      FROM jsonb_array_elements(v_response->'rows') x),'[]'::jsonb));
  ELSIF p_action IN ('cash.list','cash.entries','sales.detail','credits.list','credit.history','users.list','audit.list') THEN
    RETURN pos.operations_v1(p_action,p_data,p_key);
  END IF;
  IF p_action NOT IN ('cash.open','cash.close','cash.move','sale.confirm','sale.return','credit.limit','credit.receipt','debt.receipt','user.save','settings.save','reset.confirm') THEN
    RAISE EXCEPTION 'UNKNOWN_OPERATION' USING ERRCODE='22023'; END IF;
  -- A committed reset retry returns its original result even after the period advances.
  -- Authorization still runs first; the same actor/key/payload cannot reset twice.
  IF p_action<>'reset.confirm' THEN PERFORM pos.require_period(p_data); END IF;
  v_response:=pos.begin_request(v_actor,'v11.operations.'||p_action,p_key,p_data);
  IF v_response IS NOT NULL THEN RETURN v_response; END IF;
  IF p_action='reset.confirm' THEN PERFORM pos.require_period(p_data); END IF;
  IF p_action='user.save' AND p_data->>'role' NOT IN ('admin','cashier') THEN RAISE EXCEPTION 'INVALID_ROLE' USING ERRCODE='22023'; END IF;
  IF p_action='sale.confirm' THEN
    v_data:=p_data;
    v_customer:=(p_data->>'customer_id')::uuid;
    IF coalesce((p_data->>'finance')::boolean,false) THEN
      IF v_customer IS NULL THEN
        IF length(btrim(coalesce(p_data->>'customer_name',''))) NOT BETWEEN 1 AND 160
          OR NOT pos.valid_credit_phone(p_data->>'customer_phone') THEN RAISE EXCEPTION 'CREDIT_IDENTITY_REQUIRED'; END IF;
        -- Never match by name or phone; each new identity is a new UUID. The
        -- surrounding idempotency request ensures retries reuse that identity.
        INSERT INTO pos.customers(name,phone) VALUES(btrim(p_data->>'customer_name'),btrim(p_data->>'customer_phone')) RETURNING id INTO v_customer;
      ELSE
        IF NOT EXISTS(SELECT FROM pos.customers WHERE id=v_customer AND active AND pos.valid_credit_phone(phone)) THEN RAISE EXCEPTION 'CREDIT_IDENTITY_REQUIRED'; END IF;
      END IF;
    END IF;
    v_response:=pos.confirm_sale_v11(v_actor,v_customer,(p_data->>'session_id')::uuid,p_data->'lines',p_data->'payments',
      coalesce((p_data->>'finance')::boolean,false),p_key,
      CASE WHEN coalesce((p_data->>'finance')::boolean,false) THEN (SELECT name FROM pos.customers WHERE id=v_customer)
        ELSE p_data->>'buyer_name' END,(p_data->>'due_on')::date,(p_data->>'expected_total')::numeric);
  ELSIF p_action='debt.receipt' THEN
    SELECT * INTO v_charge FROM pos.credit_charges WHERE id=(p_data->>'charge_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'DEBT_NOT_FOUND'; END IF;
    v_account:=v_charge.account_id;
    PERFORM id FROM pos.credit_accounts WHERE id=v_account FOR UPDATE;
    PERFORM pos.lock_cash_session(v_actor,(p_data->>'session_id')::uuid);
    v_amount:=(p_data->>'amount')::numeric; PERFORM pos.require_amount(v_amount);
    SELECT outstanding INTO v_debt FROM pos.credit_charge_balances WHERE id=v_charge.id;
    IF v_amount>v_debt THEN RAISE EXCEPTION 'AMOUNT_EXCEEDS_DEBT'; END IF;
    SELECT * INTO v_method FROM pos.payment_methods WHERE id=(p_data->>'method_id')::uuid AND active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_PAYMENT_METHOD'; END IF;
    IF v_method.requires_reference AND nullif(btrim(p_data->>'reference'),'') IS NULL THEN RAISE EXCEPTION 'PAYMENT_REFERENCE_REQUIRED'; END IF;
    v_receipt:=gen_random_uuid();
    INSERT INTO pos.credit_receipts(id,account_id,amount,method_id,reference,affects_cash_snapshot,cash_session_id,received_by)
      VALUES(v_receipt,v_account,v_amount,v_method.id,p_data->>'reference',v_method.affects_cash,(p_data->>'session_id')::uuid,v_actor);
    INSERT INTO pos.credit_allocations(account_id,receipt_id,charge_id,amount) VALUES(v_account,v_receipt,v_charge.id,v_amount);
    IF v_method.affects_cash THEN
      INSERT INTO pos.cash_entries(session_id,receipt_id,amount,created_by) VALUES((p_data->>'session_id')::uuid,v_receipt,v_amount,v_actor);
    END IF;
    INSERT INTO pos.audit_events(actor_id,action,entity_id,details) VALUES(v_actor,'debt.receipt',v_receipt,jsonb_build_object('charge_id',v_charge.id,'amount',v_amount));
    v_response:=jsonb_build_object('receipt_id',v_receipt,'charge_id',v_charge.id,'outstanding',(v_debt-v_amount)::text);
  ELSIF p_action='reset.confirm' THEN
    v_session:=pos.require_recent_auth();
    IF p_data->>'confirmation' IS DISTINCT FROM 'REINICIAR OPERACION'
      OR length(btrim(coalesce(p_data->>'reason',''))) NOT BETWEEN 5 AND 500 THEN RAISE EXCEPTION 'RESET_CONFIRMATION_REQUIRED'; END IF;
    -- NOWAIT is deliberate: never wait for a concurrent commercial writer and
    -- then silently reset the just-updated operation. No advisory-lock illusion.
    BEGIN PERFORM id FROM pos.operation_state WHERE id FOR UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'OPERATION_IN_PROGRESS' USING ERRCODE='55P03'; END;
    SELECT * INTO v_intent FROM pos.reset_intents WHERE id=(p_data->>'intent_id')::uuid FOR UPDATE;
    IF NOT FOUND OR v_intent.actor_id<>v_actor OR v_intent.session_id<>v_session OR v_intent.period_id<>v_period
      OR v_intent.expires_at<clock_timestamp() OR v_intent.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'RESET_INTENT_INVALID'; END IF;
    v_snapshot:=pos.period_snapshot();
    IF v_snapshot IS DISTINCT FROM v_intent.snapshot THEN RAISE EXCEPTION 'RESET_PREVIEW_CHANGED'; END IF;
    IF (v_snapshot->>'open_sessions')::bigint<>0 THEN RAISE EXCEPTION 'OPEN_CASH_SESSIONS'; END IF;
    IF EXISTS(SELECT FROM pos.credit_charge_balances WHERE outstanding<0) OR EXISTS(SELECT FROM pos.credit_account_balances WHERE available<0)
      OR EXISTS(SELECT FROM pos.inventory_balances WHERE quantity<0) THEN RAISE EXCEPTION 'INTEGRITY_CHECK_FAILED'; END IF;
    UPDATE pos.operating_periods SET closed_at=pos.business_now(),closed_by=v_actor,reason=btrim(p_data->>'reason'),closing_snapshot=v_snapshot WHERE id=v_period AND closed_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'PERIOD_CHANGED'; END IF;
    INSERT INTO pos.operating_periods DEFAULT VALUES RETURNING id INTO v_new;
    UPDATE pos.operation_state SET period_id=v_new,revision=revision+1 WHERE id;
    INSERT INTO pos.inventory_balances(product_id,quantity) SELECT id,0 FROM pos.products;
    UPDATE pos.reset_intents SET consumed_at=clock_timestamp() WHERE id=v_intent.id;
    INSERT INTO pos.audit_events(actor_id,action,entity_id,details) VALUES(v_actor,'operation.reset',v_new,
      jsonb_build_object('previous_period_id',v_period,'reason',btrim(p_data->>'reason'),'snapshot',v_snapshot));
    v_response:=jsonb_build_object('period_id',v_new,'previous_period_id',v_period);
  ELSE
    v_data:=p_data;
    IF p_action='cash.open' AND v_role='cashier' THEN
      -- A cashier manages only their own register; no accounting entry points.
      v_data:=v_data||jsonb_build_object('register_code','C-'||substr(md5(v_actor::text),1,28));
    END IF;
    v_response:=pos.operations_v1(p_action,v_data,p_key);
  END IF;
  INSERT INTO pos.idempotency_requests VALUES(v_actor,'v11.operations.'||p_action,p_key,p_data,v_response,pos.business_now());
  RETURN v_response;
END $$;

CREATE FUNCTION public.cai_report(p_data jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pos,pg_temp AS $$
BEGIN
  IF pos.require_staff(pos.current_profile_auth_uid())<>'admin' THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN pos.report_v1(p_data);
END $$;

-- Retain exact financial invariants, including cash mirrors, stock movements,
-- initial payments, allocations, credit limits, and server-priced totals.
CREATE FUNCTION pos.assert_sale_authorization() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pos,pg_temp AS $$
BEGIN
  IF NEW.scope='sale' AND NOT EXISTS(SELECT FROM pos.credit_charges c JOIN pos.sales s ON s.id=c.sale_id
    WHERE c.sale_id=NEW.sale_id AND c.authorization_id=NEW.id AND c.account_id=NEW.account_id
      AND c.principal=NEW.financed_amount AND s.created_by=NEW.authorized_by) THEN
    RAISE EXCEPTION 'SALE_FINANCING_AUTHORIZATION_MISMATCH'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER v11_sale_authorization AFTER INSERT ON pos.credit_limit_authorizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pos.assert_sale_authorization();

-- Existing owner-only manual helper must target the composite period key.
DO $$ DECLARE v_definition text; BEGIN
  SELECT pg_get_functiondef('pos.authorize_credit_limit(uuid,uuid,numeric,text,text)'::regprocedure) INTO v_definition;
  EXECUTE replace(v_definition,'ON CONFLICT(customer_id) DO NOTHING','ON CONFLICT(customer_id,operating_period_id) DO NOTHING');
END $$;
-- Scheduler routines acquire the same row guard before account/reminder locks.
-- The explicitly enumerated entry points keep their existing specific grants.
DO $$ DECLARE r record; v_definition text; BEGIN
  FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pos'
    AND p.proname IN ('enqueue_credit_reminders','preflight_credit_reminder','record_reminder_delivery','claim_credit_reminder','finish_credit_reminder') LOOP
    SELECT pg_get_functiondef(r.oid) INTO v_definition;
    EXECUTE regexp_replace(v_definition,'BEGIN','BEGIN PERFORM pos.operation_guard();');
  END LOOP;
END $$;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='pos' AND p.oid<>'pos.current_profile_auth_uid()'::regprocedure LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,pos_app',r.signature);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.cai_catalog(text,jsonb,text),public.cai_operations(text,jsonb,text),public.cai_report(jsonb)
  FROM PUBLIC,anon,authenticated,service_role,pos_app,pos_scheduler;
GRANT EXECUTE ON FUNCTION public.cai_catalog(text,jsonb,text),public.cai_operations(text,jsonb,text),public.cai_report(jsonb) TO authenticated;
DO $$ BEGIN EXECUTE format('SET LOCAL ROLE %I',current_setting('cai.v11_migration_role')); END $$;
REVOKE CREATE ON SCHEMA pos,public FROM pos_owner;
NOTIFY pgrst,'reload schema';
COMMIT;
