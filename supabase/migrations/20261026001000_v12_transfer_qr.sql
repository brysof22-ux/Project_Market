-- CAI Market V1.2. Incremental; preserves historical ledgers and category columns.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
DO $$ BEGIN
 IF to_regprocedure('pos.confirm_sale_v11(uuid,uuid,uuid,jsonb,jsonb,boolean,text,text,date,numeric)') IS NULL THEN RAISE EXCEPTION 'MIGRATION_009_REQUIRED'; END IF;
 IF has_schema_privilege('pos_owner','pos','CREATE') OR has_schema_privilege('pos_owner','public','CREATE') THEN RAISE EXCEPTION 'REVIEW_OWNER_CREATE_PRIVILEGES'; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='pos_owner' AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)) THEN RAISE EXCEPTION 'UNSAFE_POS_OWNER'; END IF;
END $$;
SELECT set_config('cai.v12_migration_role',current_user,true);
GRANT CREATE ON SCHEMA pos,public TO pos_owner;
SET LOCAL ROLE pos_owner;
CREATE TABLE pos.transfer_qr_media (
 image_id text PRIMARY KEY CHECK(image_id ~ '^[a-f0-9]{64}$'),
 object_key text NOT NULL UNIQUE CHECK(object_key='transfer-qr/'||image_id),
 mime text NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp')),
 size integer NOT NULL CHECK(size BETWEEN 1 AND 2097152),
 width integer NOT NULL CHECK(width BETWEEN 64 AND 4096), height integer NOT NULL CHECK(height BETWEEN 64 AND 4096),
 created_by uuid NOT NULL REFERENCES pos.profiles(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE pos.transfer_qr (
 code text PRIMARY KEY CHECK(code IN ('nequi','breb')), name text NOT NULL,
 image_id text REFERENCES pos.transfer_qr_media(image_id),
 CHECK((code='nequi' AND name='Nequi') OR (code='breb' AND name='Llaves Bre-B'))
);
ALTER TABLE pos.transfer_qr ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos.transfer_qr_media ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pos.transfer_qr,pos.transfer_qr_media FROM PUBLIC,anon,authenticated,service_role,pos_app,pos_scheduler;
INSERT INTO pos.transfer_qr(code,name) VALUES('nequi','Nequi'),('breb','Llaves Bre-B');
UPDATE pos.payment_methods SET active=false WHERE code='card';
UPDATE pos.payment_methods SET requires_reference=false WHERE code='transfer';
CREATE OR REPLACE FUNCTION public.cai_catalog(p_action text,p_data jsonb DEFAULT '{}',p_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE v_actor uuid; v_role text; v_result jsonb; v_data jsonb; v_product pos.products;
  v_id uuid; v_stock integer; v_quantity numeric; v_delta integer; v_image uuid; v_qr_image text;
BEGIN
  v_actor:=pos.current_profile_auth_uid(); v_role:=pos.require_staff(v_actor);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR octet_length(p_data::text)>32768 THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
  IF v_role<>'admin' AND p_action NOT IN ('products.list','media.read','customers.search','qr.list','qr.read') THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;

  IF p_action='qr.list' THEN
    RETURN (SELECT jsonb_agg(jsonb_build_object('code',code,'name',name,'image_id',image_id) ORDER BY code DESC) FROM pos.transfer_qr);
  ELSIF p_action='qr.read' THEN
    RETURN (SELECT jsonb_build_object('image_id',q.image_id,'object_key',m.object_key,'mime',m.mime,'size',m.size)
      FROM pos.transfer_qr q JOIN pos.transfer_qr_media m ON m.image_id=q.image_id WHERE q.code=p_data->>'code');
  ELSIF p_action='qr.attach' THEN
    IF v_role<>'admin' THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
    PERFORM 1 FROM pos.transfer_qr WHERE code=p_data->>'code' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
    SELECT image_id INTO v_qr_image FROM pos.transfer_qr WHERE code=p_data->>'code';
    IF v_qr_image IS DISTINCT FROM p_data->>'expected_image_id' AND v_qr_image IS DISTINCT FROM p_data->>'image_id' THEN RAISE EXCEPTION 'IMAGE_CONFLICT'; END IF;
    INSERT INTO pos.transfer_qr_media(image_id,object_key,mime,size,width,height,created_by)
      VALUES(p_data->>'image_id',p_data->>'object_key',p_data->>'mime',(p_data->>'size')::integer,(p_data->>'width')::integer,(p_data->>'height')::integer,v_actor) ON CONFLICT(image_id) DO NOTHING;
    UPDATE pos.transfer_qr SET image_id=p_data->>'image_id' WHERE code=p_data->>'code';
    IF v_qr_image IS DISTINCT FROM p_data->>'image_id' THEN
      INSERT INTO pos.audit_events(actor_id,action,entity_id,details) VALUES(v_actor,'qr.replace',gen_random_uuid(),jsonb_build_object('code',p_data->>'code','image_id',p_data->>'image_id','previous_image_id',v_qr_image));
    END IF;
    RETURN jsonb_build_object('image_id',p_data->>'image_id');
  END IF;
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
ALTER TABLE pos.payments ADD COLUMN transfer_qr_image_id text REFERENCES pos.transfer_qr_media(image_id), ADD COLUMN transfer_qr_code text REFERENCES pos.transfer_qr(code), ADD COLUMN manually_verified boolean;
CREATE OR REPLACE FUNCTION pos.confirm_sale_v11(p_actor uuid, p_customer uuid, p_session uuid, p_lines jsonb, p_payments jsonb, p_finance_remainder boolean, p_key text, p_buyer text, p_due date, p_expected_total numeric) RETURNS jsonb
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
    IF v_method.code='transfer' THEN
      IF (v_line->>'manually_verified') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'TRANSFER_CONFIRMATION_REQUIRED'; END IF;
      PERFORM 1 FROM pos.transfer_qr WHERE code=v_line->>'qr_code' AND image_id=v_line->>'qr_image_id' AND image_id IS NOT NULL FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'IMAGE_CONFLICT'; END IF;
    END IF;

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
    INSERT INTO pos.payments(sale_id, method_id, amount, reference, affects_cash_snapshot, transfer_qr_image_id, transfer_qr_code, manually_verified) VALUES(v_sale, v_method.id, (v_line->>'amount')::numeric, v_line->>'reference', v_method.affects_cash, CASE WHEN v_method.code='transfer' THEN v_line->>'qr_image_id' END, CASE WHEN v_method.code='transfer' THEN v_line->>'qr_code' END, CASE WHEN v_method.code='transfer' THEN true END) RETURNING id INTO v_payment;
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
DO $$ BEGIN EXECUTE format('SET LOCAL ROLE %I',current_setting('cai.v12_migration_role')); END $$;
REVOKE CREATE ON SCHEMA pos,public FROM pos_owner;
NOTIFY pgrst,'reload schema';
COMMIT;
