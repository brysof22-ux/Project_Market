-- V1.3 incremental. Installing this migration NEVER executes the destructive reset.
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s';
DO $$ BEGIN
 IF to_regclass('pos.transfer_qr') IS NULL THEN RAISE EXCEPTION 'MIGRATION_010_REQUIRED'; END IF;
 IF has_schema_privilege('pos_owner','pos','CREATE') OR has_schema_privilege('pos_owner','public','CREATE') THEN RAISE EXCEPTION 'REVIEW_OWNER_CREATE_PRIVILEGES'; END IF;
END $$;
SELECT set_config('cai.v13_role',current_user,true);
GRANT CREATE ON SCHEMA pos,public TO pos_owner;
SET LOCAL ROLE pos_owner;
-- A short exclusive row guard prevents commercial writes while upgrading.
SELECT period_id FROM pos.operation_state WHERE id FOR UPDATE NOWAIT;

ALTER TABLE pos.products ALTER COLUMN purchase_price TYPE numeric(24,6), ALTER COLUMN minimum SET DEFAULT 5;
ALTER TABLE pos.sale_items ALTER COLUMN purchase_price_snapshot TYPE numeric(24,6);
CREATE TABLE pos.inventory_purchases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES pos.products(id),
 quantity integer NOT NULL CHECK(quantity>0), total numeric(18,2) NOT NULL CHECK(total>=0),
 unit_cost numeric(24,6) NOT NULL CHECK(unit_cost>=0), previous_stock integer NOT NULL,
 resulting_stock integer NOT NULL, resulting_cost numeric(24,6),
 created_by uuid NOT NULL REFERENCES pos.profiles(id),created_at timestamptz NOT NULL DEFAULT pos.business_now(),
 operating_period_id uuid NOT NULL DEFAULT pos.current_period() REFERENCES pos.operating_periods(id)
);
ALTER TABLE pos.inventory_purchases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pos.inventory_purchases FROM PUBLIC,anon,authenticated,service_role,pos_app,pos_scheduler;
CREATE TRIGGER v13_write_gate BEFORE INSERT OR UPDATE OR DELETE ON pos.inventory_purchases FOR EACH STATEMENT EXECUTE FUNCTION pos.guard_write();
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON pos.inventory_purchases FOR EACH ROW EXECUTE FUNCTION pos.prevent_financial_mutation();
CREATE FUNCTION pos.receive_inventory(p_action text,p_data jsonb,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pos,pg_temp AS $$
<<purchase>>
DECLARE actor uuid:=pos.current_profile_auth_uid(); result jsonb; product pos.products; id uuid; qty numeric;
 old_stock integer; total numeric; price numeric; minimum numeric; unit numeric; average numeric;
BEGIN
 IF pos.require_staff(actor)<>'admin' THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM pos.require_period(p_data);
 result:=pos.begin_request(actor,'v13.inventory.'||p_action,p_key,p_data); IF result IS NOT NULL THEN RETURN result; END IF;
 qty:=(p_data->>'incoming_quantity')::numeric; total:=(p_data->>'purchase_total')::numeric;
 IF qty IS NULL OR qty<>trunc(qty) OR qty NOT BETWEEN 0 AND 1000000 OR total IS NULL OR total<0 OR total<>round(total,2) OR total>=10000000000000000 OR (qty=0 AND total<>0) THEN RAISE EXCEPTION 'INVALID_PURCHASE'; END IF;
 id:=coalesce((p_data->>'id')::uuid,(p_data->>'product_id')::uuid);
 IF id IS NULL THEN
  IF p_action<>'product.save' THEN RAISE EXCEPTION 'PRODUCT_NOT_AVAILABLE'; END IF;
  id:=gen_random_uuid(); old_stock:=0;
 ELSE
  SELECT * INTO product FROM pos.products WHERE products.id=purchase.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_AVAILABLE'; END IF;
  IF product.version IS DISTINCT FROM (p_data->>'version')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  SELECT quantity INTO old_stock FROM pos.inventory_balances WHERE product_id=purchase.id FOR UPDATE;
  IF old_stock IS NULL THEN RAISE EXCEPTION 'PRODUCT_NOT_AVAILABLE'; END IF;
 END IF;
 IF old_stock::bigint+qty>2147483647 THEN RAISE EXCEPTION 'INVALID_PURCHASE'; END IF;
 unit:=CASE WHEN qty>0 THEN round(total/qty,6) END;
 average:=CASE WHEN qty=0 THEN product.purchase_price WHEN old_stock=0 THEN unit
  WHEN product.purchase_price IS NULL THEN NULL ELSE round((old_stock*product.purchase_price+total)/(old_stock+qty),6) END;
 IF p_action='product.save' THEN
  price:=(p_data->>'price')::numeric; PERFORM pos.require_amount(price);
  minimum:=coalesce((p_data->>'minimum')::numeric,product.minimum,5);
  IF length(btrim(coalesce(p_data->>'name',''))) NOT BETWEEN 1 AND 160 OR minimum<>trunc(minimum) OR minimum NOT BETWEEN 0 AND 1000000 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF product.id IS NULL THEN
   INSERT INTO pos.products(id,sku,name,price,purchase_price,minimum) VALUES(id,'CAI-'||replace(id::text,'-',''),btrim(p_data->>'name'),price,average,minimum::integer);
   INSERT INTO pos.inventory_balances(product_id,quantity) VALUES(id,0);
  ELSE
   UPDATE pos.products SET name=btrim(p_data->>'name'),price=purchase.price,purchase_price=average,minimum=purchase.minimum::integer,version=version+1 WHERE products.id=purchase.id;
  END IF;
 ELSE
  IF qty=0 THEN RAISE EXCEPTION 'INVALID_PURCHASE'; END IF;
  UPDATE pos.products SET purchase_price=average,version=version+1 WHERE products.id=purchase.id;
 END IF;
 IF qty>0 THEN
  UPDATE pos.inventory_balances SET quantity=quantity+qty::integer WHERE product_id=purchase.id;
  INSERT INTO pos.inventory_purchases(product_id,quantity,total,unit_cost,previous_stock,resulting_stock,resulting_cost,created_by)
   VALUES(id,qty::integer,total,unit,old_stock,old_stock+qty::integer,average,actor);
  INSERT INTO pos.inventory_adjustments(product_id,quantity_delta,reason,created_by) VALUES(id,qty::integer,'Compra / reabastecimiento',actor);
 END IF;
 INSERT INTO pos.audit_events(actor_id,action,entity_id) VALUES(actor,'inventory.purchase',id);
 result:=jsonb_build_object('id',id,'stock',old_stock+qty::integer,'unit_cost',unit::text,'average_cost',average::text);
 INSERT INTO pos.idempotency_requests VALUES(actor,'v13.inventory.'||p_action,p_key,p_data,result,pos.business_now());
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.cai_catalog(p_action text,p_data jsonb DEFAULT '{}',p_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE v_actor uuid; v_role text; v_result jsonb; v_data jsonb; v_product pos.products;
  v_id uuid; v_stock integer; v_quantity numeric; v_delta integer; v_image uuid; v_qr_image text;
BEGIN
  v_actor:=pos.current_profile_auth_uid(); v_role:=pos.require_staff(v_actor);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR octet_length(p_data::text)>32768 THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
  IF v_role<>'admin' AND p_action NOT IN ('products.list','media.read','customers.search','qr.list','qr.read') THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;

  IF p_action='inventory.receive' OR (p_action='product.save' AND p_data ? 'incoming_quantity') THEN RETURN pos.receive_inventory(p_action,p_data,p_key); END IF;
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

-- Real notifications are a new per-debt outbox; the old mock/monthly ledger remains unchanged.
ALTER TABLE pos.communication_consents DROP CONSTRAINT communication_consents_purpose_check,
 ADD CONSTRAINT communication_consents_purpose_check CHECK(purpose IN ('credit_reminder','credit_notifications'));
CREATE TABLE pos.whatsapp_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), enabled boolean NOT NULL DEFAULT false,
 purchases boolean NOT NULL DEFAULT true, receipts boolean NOT NULL DEFAULT true, reminders boolean NOT NULL DEFAULT true,
 days_before integer NOT NULL DEFAULT 1 CHECK(days_before BETWEEN 1 AND 30), worker_hash bytea,
 connection_state text NOT NULL DEFAULT 'unconfigured',connected_number text CHECK(connected_number ~ '^\+[1-9][0-9]{7,14}$'),last_connection timestamptz,last_success timestamptz,last_error text
);
INSERT INTO pos.whatsapp_settings(id) VALUES(true);
CREATE TABLE pos.notification_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_key text NOT NULL UNIQUE,
 customer_id uuid NOT NULL REFERENCES pos.customers(id),charge_id uuid REFERENCES pos.credit_charges(id),receipt_id uuid REFERENCES pos.credit_receipts(id),
 kind text NOT NULL CHECK(kind IN ('credit_purchase','receipt','debt_paid','reminder','test')),
 payload jsonb NOT NULL DEFAULT '{}', scheduled_on date,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','retry','sending','sent','failed','unknown','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5), next_attempt timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease uuid,lease_until timestamptz,provider_id text,error_code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),sent_at timestamptz,
 operating_period_id uuid NOT NULL DEFAULT pos.current_period() REFERENCES pos.operating_periods(id)
);
CREATE INDEX notification_pending ON pos.notification_jobs(next_attempt,id) WHERE status IN ('queued','retry');
ALTER TABLE pos.whatsapp_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos.notification_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pos.whatsapp_settings,pos.notification_jobs FROM PUBLIC,anon,authenticated,service_role,pos_app,pos_scheduler;
CREATE TRIGGER v13_write_gate BEFORE INSERT OR UPDATE OR DELETE ON pos.notification_jobs FOR EACH STATEMENT EXECUTE FUNCTION pos.guard_write();
CREATE FUNCTION pos.whatsapp_phone(p_phone text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN p_phone !~ '^[+0-9() .-]{7,30}$' THEN NULL WHEN regexp_replace(p_phone,'[^0-9]','','g') ~ '^[0-9]{10}$' THEN '+57'||regexp_replace(p_phone,'[^0-9]','','g')
 WHEN regexp_replace(p_phone,'[^0-9]','','g') ~ '^[1-9][0-9]{7,14}$' THEN '+'||regexp_replace(p_phone,'[^0-9]','','g') END
$$;
CREATE FUNCTION pos.notification_phone(p_customer uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,pos,pg_temp AS $$
 SELECT w.phone_e164 FROM pos.whatsapp_contacts w JOIN pos.customers c ON c.id=w.customer_id
 JOIN LATERAL (SELECT granted,phone_e164 FROM pos.communication_consents WHERE customer_id=c.id AND purpose='credit_notifications' ORDER BY id DESC LIMIT 1) consent ON true
 WHERE c.id=p_customer AND c.active AND w.verified_at IS NOT NULL AND consent.granted AND consent.phone_e164=w.phone_e164 AND pos.whatsapp_phone(c.phone)=w.phone_e164
$$;
CREATE FUNCTION pos.notification_consent(p_actor uuid,p_customer uuid,p_granted boolean,p_evidence text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE phone text;
BEGIN
 SELECT pos.whatsapp_phone(customers.phone) INTO phone FROM pos.customers WHERE id=p_customer AND active;
 IF phone IS NULL OR p_granted IS NULL OR length(btrim(coalesce(p_evidence,''))) NOT BETWEEN 5 AND 1000 THEN RAISE EXCEPTION 'INVALID_CONSENT'; END IF;
 INSERT INTO pos.whatsapp_contacts(customer_id,phone_e164,verified_at,updated_by) VALUES(p_customer,phone,clock_timestamp(),p_actor)
 ON CONFLICT(customer_id) DO UPDATE SET phone_e164=excluded.phone_e164,verified_at=clock_timestamp(),updated_by=p_actor,updated_at=clock_timestamp();
 INSERT INTO pos.communication_consents(customer_id,phone_e164,purpose,granted,source,evidence,captured_by)
 VALUES(p_customer,phone,'credit_notifications',p_granted,'CAI Market V1.3',p_evidence,p_actor);
END $$;
CREATE FUNCTION pos.enqueue_notification(p_charge uuid,p_kind text,p_receipt uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE debt jsonb; amount numeric; customer uuid; config pos.whatsapp_settings; event text;
BEGIN
 SELECT * INTO config FROM pos.whatsapp_settings WHERE id;
 IF NOT config.enabled THEN RETURN; END IF;
 IF (p_kind='credit_purchase' AND NOT config.purchases) OR (p_kind IN ('receipt','debt_paid') AND NOT config.receipts) THEN RETURN; END IF;
 debt:=pos.debt_row(p_charge); IF debt IS NULL OR (debt->>'returned')::boolean THEN RETURN; END IF;
 customer:=(debt->>'customer_id')::uuid;
 IF pos.notification_phone(customer) IS NULL THEN RETURN; END IF;
 IF p_receipt IS NOT NULL THEN SELECT sum(a.amount) INTO amount FROM pos.credit_allocations a WHERE receipt_id=p_receipt AND charge_id=p_charge; END IF;
 event:=p_kind||':'||coalesce(p_receipt,p_charge)::text||':'||p_charge::text;
 INSERT INTO pos.notification_jobs(event_key,customer_id,charge_id,receipt_id,kind,payload)
 VALUES(event,customer,p_charge,p_receipt,p_kind,debt||jsonb_build_object('receipt_amount',amount::text,'previous_balance',((debt->>'outstanding')::numeric+coalesce(amount,0))::text)) ON CONFLICT(event_key) DO NOTHING;
END $$;
CREATE FUNCTION pos.whatsapp_admin(p_action text,p_data jsonb,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE actor uuid:=pos.current_profile_auth_uid(); response jsonb; settings pos.whatsapp_settings; v_id uuid;
BEGIN
 IF pos.require_staff(actor)<>'admin' THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM pos.operation_guard();
 IF p_action='whatsapp.status' THEN
  SELECT to_jsonb(s)-'worker_hash' INTO response FROM pos.whatsapp_settings s WHERE s.id;
  RETURN jsonb_build_object('settings',response,'counts',(SELECT jsonb_build_object('pending',count(*) FILTER(WHERE status IN ('queued','retry','sending')),'sent',count(*) FILTER(WHERE status='sent'),'failed',count(*) FILTER(WHERE status IN ('failed','unknown'))) FROM pos.notification_jobs),
   'jobs',coalesce((SELECT jsonb_agg(to_jsonb(j)) FROM (SELECT id,kind,status,attempts,error_code,created_at,sent_at FROM pos.notification_jobs ORDER BY created_at DESC LIMIT 30) j),'[]'::jsonb),
   'contacts',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'phone',phone,'consented',pos.notification_phone(id) IS NOT NULL)) FROM (SELECT id,name,phone FROM pos.customers WHERE active ORDER BY name,id LIMIT 100) c),'[]'::jsonb));
 END IF;
 PERFORM pos.require_period(p_data);
 response:=pos.begin_request(actor,'v13.'||p_action,p_key,p_data); IF response IS NOT NULL THEN RETURN response; END IF;
 IF p_action='whatsapp.settings' THEN
  IF (p_data->>'enabled')::boolean AND NOT EXISTS(SELECT FROM pos.whatsapp_settings WHERE id AND connection_state='open' AND last_connection>clock_timestamp()-interval '5 minutes') THEN RAISE EXCEPTION 'WHATSAPP_NOT_READY'; END IF;
  IF (p_data->>'enabled')::boolean AND NOT EXISTS(SELECT FROM pos.customers WHERE pos.notification_phone(id) IS NOT NULL) THEN RAISE EXCEPTION 'CONSENT_REQUIRED'; END IF;
  UPDATE pos.whatsapp_settings SET enabled=coalesce((p_data->>'enabled')::boolean,false),purchases=coalesce((p_data->>'purchases')::boolean,true),receipts=coalesce((p_data->>'receipts')::boolean,true),reminders=coalesce((p_data->>'reminders')::boolean,true),days_before=coalesce((p_data->>'days_before')::integer,1) WHERE whatsapp_settings.id;
 ELSIF p_action='whatsapp.contact' THEN
  PERFORM pos.notification_consent(actor,(p_data->>'customer_id')::uuid,(p_data->>'granted')::boolean,p_data->>'evidence');
 ELSIF p_action='whatsapp.test' THEN
  v_id:=(p_data->>'customer_id')::uuid;
  IF p_data->>'authorized' IS DISTINCT FROM 'true' OR pos.notification_phone(v_id) IS NULL THEN RAISE EXCEPTION 'CONSENT_REQUIRED'; END IF;
  IF NOT EXISTS(SELECT FROM pos.whatsapp_settings WHERE enabled AND connection_state='open') THEN RAISE EXCEPTION 'WHATSAPP_NOT_READY'; END IF;
  INSERT INTO pos.notification_jobs(event_key,customer_id,kind,payload) VALUES('test:'||actor::text||':'||p_key,v_id,'test',jsonb_build_object('name',(SELECT name FROM pos.customers WHERE customers.id=v_id)));
 ELSIF p_action='whatsapp.retry' THEN
  UPDATE pos.notification_jobs SET status='queued',attempts=0,next_attempt=clock_timestamp(),error_code=NULL WHERE notification_jobs.id=(p_data->>'job_id')::uuid AND status='failed';
  IF NOT FOUND THEN RAISE EXCEPTION 'NOTIFICATION_NOT_RETRYABLE'; END IF;
 ELSE RAISE EXCEPTION 'UNKNOWN_OPERATION'; END IF;
 response:=jsonb_build_object('id',gen_random_uuid());
 INSERT INTO pos.audit_events(actor_id,action,entity_id) VALUES(actor,p_action,(response->>'id')::uuid);
 INSERT INTO pos.idempotency_requests VALUES(actor,'v13.'||p_action,p_key,p_data,response,pos.business_now());
 RETURN response;
END $$;
CREATE FUNCTION public.cai_whatsapp_dispatch(p_secret text,p_action text,p_data jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE config pos.whatsapp_settings; job pos.notification_jobs; debt jsonb; today date:=(pos.business_now() AT TIME ZONE 'America/Bogota')::date; customer uuid;
BEGIN
 SELECT * INTO config FROM pos.whatsapp_settings WHERE id;
 IF p_secret IS NULL OR length(p_secret)<32 OR config.worker_hash IS NULL OR sha256(convert_to(p_secret,'UTF8'))<>config.worker_hash THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR octet_length(p_data::text)>32768 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
 PERFORM pos.operation_guard();
 IF p_action='health' THEN
  IF p_data->>'state' NOT IN ('open','close','connecting','unconfigured','unavailable') THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  UPDATE pos.whatsapp_settings SET connection_state=p_data->>'state',connected_number=CASE WHEN p_data->>'state'='open' AND p_data->>'connected_number' ~ '^\+[1-9][0-9]{7,14}$' THEN p_data->>'connected_number' ELSE NULL END,last_connection=CASE WHEN p_data->>'state'='open' THEN clock_timestamp() ELSE last_connection END,
   last_error=CASE WHEN p_data->>'state'='open' THEN NULL ELSE 'EVOLUTION_UNAVAILABLE' END WHERE id;
  RETURN jsonb_build_object('enabled',config.enabled);
 ELSIF p_action='finish' THEN
  SELECT * INTO job FROM pos.notification_jobs WHERE lease=(p_data->>'lease')::uuid AND status='sending' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','ignored'); END IF;
  IF p_data->>'outcome'='sent' AND length(coalesce(p_data->>'provider_id','')) BETWEEN 1 AND 200 THEN
   UPDATE pos.notification_jobs SET status='sent',provider_id=p_data->>'provider_id',sent_at=clock_timestamp(),lease_until=NULL WHERE id=job.id;
   UPDATE pos.whatsapp_settings SET last_success=clock_timestamp(),last_error=NULL WHERE id;
  ELSE
   UPDATE pos.notification_jobs SET status=CASE WHEN p_data->>'outcome'='retry' AND attempts<5 THEN 'retry' WHEN p_data->>'outcome'='failed' OR (p_data->>'outcome'='retry' AND attempts>=5) THEN 'failed' ELSE 'unknown' END,
    error_code=CASE WHEN p_data->>'outcome'='retry' THEN 'PROVIDER_REJECTED_RETRYABLE' WHEN p_data->>'outcome'='failed' THEN 'PROVIDER_REJECTED' ELSE 'PROVIDER_RESULT_UNKNOWN' END,
    next_attempt=clock_timestamp()+interval '5 minutes'*greatest(1,attempts),lease_until=NULL WHERE id=job.id;
   UPDATE pos.whatsapp_settings SET last_error='NOTIFICATION_DISPATCH_FAILED' WHERE id;
  END IF;
  RETURN jsonb_build_object('status','finished');
 END IF;
 IF NOT config.enabled OR config.connection_state<>'open' OR config.last_connection<clock_timestamp()-interval '5 minutes' THEN RETURN NULL; END IF;
 IF p_action='enqueue' THEN
  IF config.reminders AND extract(hour FROM pos.business_now() AT TIME ZONE 'America/Bogota')>=9 THEN
   INSERT INTO pos.notification_jobs(event_key,customer_id,charge_id,kind,scheduled_on,payload)
    SELECT 'reminder:'||b.id::text||':'||today::text,b.customer_id,b.id,'reminder',today,pos.debt_row(b.id)
    FROM pos.credit_charge_balances b WHERE b.outstanding>0 AND b.due_on IS NOT NULL AND b.due_on-today IN (0,config.days_before) AND pos.notification_phone(b.customer_id) IS NOT NULL ON CONFLICT(event_key) DO NOTHING;
  END IF;
  RETURN jsonb_build_object('status','enqueued');
 ELSIF p_action='claim' THEN
  UPDATE pos.notification_jobs SET status='unknown',error_code='DISPATCH_LEASE_EXPIRED' WHERE status='sending' AND lease_until<clock_timestamp();
  FOR job IN SELECT * FROM pos.notification_jobs WHERE operating_period_id=pos.current_period() AND status IN ('queued','retry') AND attempts<5 AND next_attempt<=clock_timestamp() ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 25 LOOP
   IF pos.notification_phone(job.customer_id) IS NULL OR (job.kind='reminder' AND (job.scheduled_on<>today OR NOT config.reminders))
    OR (job.kind='credit_purchase' AND NOT config.purchases) OR (job.kind IN ('receipt','debt_paid') AND NOT config.receipts) THEN
    UPDATE pos.notification_jobs SET status='cancelled',error_code='CONSENT_OR_SETTINGS_CHANGED' WHERE id=job.id; CONTINUE;
   END IF;
   IF job.charge_id IS NOT NULL THEN
    debt:=pos.debt_row(job.charge_id);
    IF debt IS NULL OR (debt->>'returned')::boolean OR (job.kind='reminder' AND (debt->>'outstanding')::numeric<=0) THEN
     UPDATE pos.notification_jobs SET status='cancelled',error_code='DEBT_OBSOLETE' WHERE id=job.id; CONTINUE;
    END IF;
    IF job.kind='reminder' THEN UPDATE pos.notification_jobs SET payload=debt WHERE id=job.id;job.payload:=debt; END IF;
   END IF;
   UPDATE pos.notification_jobs SET status='sending',attempts=attempts+1,lease=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes' WHERE id=job.id RETURNING * INTO job;
   RETURN jsonb_build_object('id',job.id,'lease',job.lease,'kind',job.kind,'phone',pos.notification_phone(job.customer_id),'payload',job.payload);
  END LOOP;
  RETURN NULL;
 ELSIF p_action='preflight' THEN
  SELECT * INTO job FROM pos.notification_jobs WHERE lease=(p_data->>'lease')::uuid AND status='sending' AND lease_until>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF pos.notification_phone(job.customer_id) IS NULL OR (job.kind='reminder' AND (job.scheduled_on<>today OR NOT EXISTS(SELECT FROM pos.credit_charge_balances WHERE id=job.charge_id AND outstanding>0))) THEN
   UPDATE pos.notification_jobs SET status='cancelled',error_code='CONSENT_OR_DEBT_CHANGED' WHERE id=job.id; RETURN NULL;
  END IF;
  RETURN jsonb_build_object('lease',job.lease,'kind',job.kind,'phone',pos.notification_phone(job.customer_id),'payload',job.payload);
 END IF;
 RAISE EXCEPTION 'UNKNOWN_OPERATION';
END $$;

-- Only this narrowly scoped SECURITY DEFINER path can opt into deletion.
-- Employee roles retain no direct table or helper privileges.
CREATE OR REPLACE FUNCTION pos.prevent_financial_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pos,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' AND current_user='pos_owner' AND current_setting('cai.destructive_reset',true)='on' THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'IMMUTABLE_FINANCIAL_RECORD';
END $$;
CREATE POLICY v13_reset_read ON pos.reminder_delivery_events FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.reminder_delivery_events FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.reminder_attempts FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.reminder_attempts FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.credit_reminders FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.credit_reminders FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.notification_jobs FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.notification_jobs FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.cash_closings FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.cash_closings FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.cash_adjustments FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.cash_adjustments FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.sale_returns FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.sale_returns FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.cash_entries FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.cash_entries FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.inventory_movements FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.inventory_movements FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.payments FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.payments FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.sale_items FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.sale_items FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.credit_allocations FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.credit_allocations FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.credit_receipts FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.credit_receipts FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.credit_charges FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.credit_charges FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.credit_limit_authorizations FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.credit_limit_authorizations FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.credit_accounts FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.credit_accounts FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.sales FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.sales FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.cash_sessions FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.cash_sessions FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.inventory_adjustments FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.inventory_adjustments FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.inventory_purchases FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.inventory_purchases FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.inventory_balances FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.inventory_balances FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.audit_events FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.audit_events FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');
CREATE POLICY v13_reset_read ON pos.idempotency_requests FOR SELECT TO pos_owner USING(current_setting('cai.reset_read',true)='on');
CREATE POLICY v13_reset_delete ON pos.idempotency_requests FOR DELETE TO pos_owner USING(current_setting('cai.destructive_reset',true)='on');

CREATE FUNCTION pos.reset_snapshot_v13() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE snapshot jsonb; fingerprint jsonb:='{}'; name text; digest text;
BEGIN
 PERFORM set_config('cai.reset_read','on',true);
 snapshot:=jsonb_build_object('period_id',pos.current_period(),'sales',(SELECT count(*) FROM pos.sales),'debts',(SELECT count(*) FROM pos.credit_charges),
  'outstanding',(SELECT coalesce(sum(principal),0)-coalesce((SELECT sum(amount) FROM pos.credit_allocations),0)-coalesce((SELECT sum(credit_reduction) FROM pos.sale_returns),0) FROM pos.credit_charges)::text,
  'stock',(SELECT coalesce(sum(quantity),0) FROM pos.inventory_balances),'open_sessions',(SELECT count(*) FROM pos.cash_sessions WHERE closed_at IS NULL));
 FOREACH name IN ARRAY ARRAY['reminder_delivery_events','reminder_attempts','credit_reminders','notification_jobs','cash_closings','cash_adjustments','sale_returns','cash_entries','inventory_movements','payments','sale_items','credit_allocations','credit_receipts','credit_charges','credit_limit_authorizations','credit_accounts','sales','cash_sessions','inventory_adjustments','inventory_purchases','inventory_balances','audit_events','idempotency_requests'] LOOP
  EXECUTE format('SELECT md5(coalesce(string_agg(md5(to_jsonb(t)::text),%L ORDER BY md5(to_jsonb(t)::text)),%L)) FROM pos.%I t','','',name) INTO digest;
  fingerprint:=fingerprint||jsonb_build_object(name,digest);
 END LOOP;
 PERFORM set_config('cai.reset_read','',true);
 RETURN snapshot||jsonb_build_object('fingerprint',fingerprint);
END $$;
CREATE FUNCTION pos.purge_operation(p_data jsonb,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE session uuid; intent pos.reset_intents; snapshot jsonb; new_period uuid; seq text; name text;
BEGIN
 IF pos.require_staff(p_actor)<>'admin' THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
 session:=pos.require_recent_auth();
 IF p_data->>'confirmation' IS DISTINCT FROM 'ELIMINAR OPERACION' OR length(btrim(coalesce(p_data->>'reason',''))) NOT BETWEEN 5 AND 500 THEN RAISE EXCEPTION 'RESET_CONFIRMATION_REQUIRED'; END IF;
 BEGIN PERFORM id FROM pos.operation_state WHERE id FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'OPERATION_IN_PROGRESS' USING ERRCODE='55P03'; END;
 SELECT * INTO intent FROM pos.reset_intents WHERE id=(p_data->>'intent_id')::uuid FOR UPDATE;
 IF NOT FOUND OR intent.actor_id<>p_actor OR intent.session_id<>session OR intent.period_id<>pos.current_period() OR intent.expires_at<clock_timestamp() OR intent.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'RESET_INTENT_INVALID'; END IF;
 snapshot:=pos.reset_snapshot_v13();
 IF snapshot IS DISTINCT FROM intent.snapshot THEN RAISE EXCEPTION 'RESET_PREVIEW_CHANGED'; END IF;
 IF EXISTS(SELECT FROM pos.notification_jobs WHERE status='sending' AND lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'NOTIFICATIONS_IN_PROGRESS'; END IF;
 -- Locks and all deletes, period change and identity restart roll back together.
 PERFORM set_config('cai.reset_read','on',true);
 PERFORM set_config('cai.destructive_reset','on',true);
 SET CONSTRAINTS ALL DEFERRED;
 FOREACH name IN ARRAY ARRAY['reminder_delivery_events','reminder_attempts','credit_reminders','notification_jobs','cash_closings','cash_adjustments','sale_returns','cash_entries','inventory_movements','payments','sale_items','credit_allocations','credit_receipts','credit_charges','credit_limit_authorizations','credit_accounts','sales','cash_sessions','inventory_adjustments','inventory_purchases','inventory_balances','audit_events','idempotency_requests'] LOOP
  EXECUTE format('DELETE FROM pos.%I',name);
 END LOOP;
 DELETE FROM pos.reset_intents;
 UPDATE pos.operating_periods SET closed_at=pos.business_now(),closed_by=p_actor,reason=btrim(p_data->>'reason'),closing_snapshot=NULL WHERE id=pos.current_period();
 INSERT INTO pos.operating_periods DEFAULT VALUES RETURNING id INTO new_period;
 UPDATE pos.operation_state SET period_id=new_period,revision=revision+1 WHERE id;
 DELETE FROM pos.operating_periods WHERE id<>new_period;
 INSERT INTO pos.inventory_balances(product_id,quantity) SELECT id,0 FROM pos.products;
 seq:=pg_get_serial_sequence('pos.sales','number'); EXECUTE format('ALTER SEQUENCE %s RESTART WITH 1',seq::regclass);
 PERFORM set_config('cai.destructive_reset','',true); PERFORM set_config('cai.reset_read','',true);
 INSERT INTO pos.audit_events(actor_id,action,entity_id) VALUES(p_actor,'operation.destructive_reset',new_period);
 RETURN jsonb_build_object('period_id',new_period,'destructive',true);
END $$;
CREATE OR REPLACE FUNCTION public.cai_operations(p_action text,p_data jsonb DEFAULT '{}',p_key text DEFAULT NULL)
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
  IF p_action LIKE 'whatsapp.%' THEN RETURN pos.whatsapp_admin(p_action,p_data,p_key); END IF;
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
    v_snapshot:=pos.reset_snapshot_v13();
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
    v_response:=pos.purge_operation(p_data,v_actor);
  ELSE
    v_data:=p_data;
    IF p_action='cash.open' AND v_role='cashier' THEN
      -- A cashier manages only their own register; no accounting entry points.
      v_data:=v_data||jsonb_build_object('register_code','C-'||substr(md5(v_actor::text),1,28));
    END IF;
    v_response:=pos.operations_v1(p_action,v_data,p_key);
  END IF;
  IF p_action='sale.confirm' AND v_response->>'charge_id' IS NOT NULL THEN
    IF p_data->>'notification_consent'='true' THEN PERFORM pos.notification_consent(v_actor,v_customer,true,'Autorización explícita del cliente para avisos y recordatorios de sus compras a crédito.'); END IF;
    PERFORM pos.enqueue_notification((v_response->>'charge_id')::uuid,'credit_purchase');
  ELSIF p_action='debt.receipt' THEN
    PERFORM pos.enqueue_notification(v_charge.id,'receipt',v_receipt);
    IF (v_response->>'outstanding')::numeric=0 THEN PERFORM pos.enqueue_notification(v_charge.id,'debt_paid',v_receipt); END IF;
  ELSIF p_action='credit.receipt' THEN
    v_receipt:=(v_response->>'receipt_id')::uuid;
    FOR v_charge IN SELECT c.* FROM pos.credit_charges c JOIN pos.credit_allocations a ON a.charge_id=c.id WHERE a.receipt_id=v_receipt LOOP
      PERFORM pos.enqueue_notification(v_charge.id,'receipt',v_receipt);
      IF (pos.debt_row(v_charge.id)->>'outstanding')::numeric=0 THEN PERFORM pos.enqueue_notification(v_charge.id,'debt_paid',v_receipt); END IF;
    END LOOP;
  END IF;
  INSERT INTO pos.idempotency_requests VALUES(v_actor,'v11.operations.'||p_action,p_key,p_data,v_response,pos.business_now());
  RETURN v_response;
END $$;

CREATE OR REPLACE FUNCTION public.cai_report(p_data jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE result jsonb; from_day date; to_day date; financial jsonb; trend jsonb;
BEGIN
 IF pos.require_staff(pos.current_profile_auth_uid())<>'admin' THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
 result:=pos.report_v1(p_data); from_day:=(result->>'from')::date;to_day:=(result->>'to')::date;
 WITH events AS (
  SELECT i.product_id,i.name_snapshot,i.quantity,i.total,i.purchase_price_snapshot,(s.created_at AT TIME ZONE 'America/Bogota')::date AS day FROM pos.sale_items i JOIN pos.sales s ON s.id=i.sale_id
  UNION ALL SELECT i.product_id,i.name_snapshot,-i.quantity,-i.total,i.purchase_price_snapshot,(r.created_at AT TIME ZONE 'America/Bogota')::date FROM pos.sale_items i JOIN pos.sale_returns r ON r.sale_id=i.sale_id
 ), selected AS (SELECT * FROM events WHERE day BETWEEN from_day AND to_day), cost AS (
  SELECT CASE WHEN count(*) FILTER(WHERE purchase_price_snapshot IS NULL)>0 THEN NULL ELSE coalesce(sum(quantity*purchase_price_snapshot),0) END amount FROM selected
 ), inventory AS (
  SELECT count(*) FILTER(WHERE b.quantity>0 AND p.purchase_price IS NULL) unknown,
   CASE WHEN count(*) FILTER(WHERE b.quantity>0 AND p.purchase_price IS NULL)>0 THEN NULL ELSE coalesce(sum(b.quantity*p.purchase_price),0) END amount FROM pos.products p JOIN pos.inventory_balances b ON b.product_id=p.id
 )
 SELECT jsonb_build_object('cogs',cost.amount::text,'net_profit',CASE WHEN cost.amount IS NULL THEN NULL ELSE ((result->>'net_sales')::numeric-cost.amount-(result->>'expenses')::numeric)::text END,
  'cash_received',coalesce((SELECT sum((x->>'total')::numeric) FROM jsonb_array_elements(result->'methods') x WHERE x->>'code'='cash'),0)::text,
  'transfers_received',coalesce((SELECT sum((x->>'total')::numeric) FROM jsonb_array_elements(result->'methods') x WHERE x->>'code'='transfer'),0)::text,
  'cash_on_hand',(SELECT coalesce(sum(s.opening_float+coalesce((SELECT sum(amount) FROM pos.cash_entries e WHERE e.session_id=s.id),0)+coalesce((SELECT sum(amount) FROM pos.cash_adjustments a WHERE a.session_id=s.id),0)),0)::text FROM pos.cash_sessions s WHERE closed_at IS NULL),
  'inventory_value',inventory.amount::text,'unknown_inventory_costs',inventory.unknown,
  'gross_margin',CASE WHEN cost.amount IS NULL OR (result->>'net_sales')::numeric=0 THEN NULL ELSE round(((result->>'net_sales')::numeric-cost.amount)/(result->>'net_sales')::numeric*100,4)::text END,
  'profitable_products',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT product_id,max(name_snapshot) name,
   CASE WHEN count(*) FILTER(WHERE purchase_price_snapshot IS NULL)>0 THEN NULL ELSE sum(total-quantity*purchase_price_snapshot)::text END profit FROM selected GROUP BY product_id ORDER BY sum(total-quantity*purchase_price_snapshot) DESC NULLS LAST,product_id LIMIT 10) x),'[]'::jsonb)) INTO financial FROM cost CROSS JOIN inventory;
 WITH days AS (SELECT d::date AS day FROM generate_series(from_day::timestamp,to_day::timestamp,interval '1 day') d), items AS (
  SELECT (s.created_at AT TIME ZONE 'America/Bogota')::date AS day,i.quantity,i.total,i.purchase_price_snapshot FROM pos.sale_items i JOIN pos.sales s ON s.id=i.sale_id
  UNION ALL SELECT (r.created_at AT TIME ZONE 'America/Bogota')::date,-i.quantity,-i.total,i.purchase_price_snapshot FROM pos.sale_items i JOIN pos.sale_returns r ON r.sale_id=i.sale_id
 ), daily AS (
  SELECT days.day,coalesce(sum(i.total),0) sales,
   CASE WHEN count(*) FILTER(WHERE i.total IS NOT NULL AND i.purchase_price_snapshot IS NULL)>0 THEN NULL ELSE coalesce(sum(i.total-i.quantity*i.purchase_price_snapshot),0) END gross_profit,
   coalesce((SELECT -sum(amount) FROM pos.cash_adjustments WHERE kind='expense' AND (created_at AT TIME ZONE 'America/Bogota')::date=days.day),0) expenses,
   coalesce((SELECT sum(principal) FROM pos.credit_charges WHERE purchased_on<=days.day),0)
   -coalesce((SELECT sum(a.amount) FROM pos.credit_allocations a JOIN pos.credit_receipts r ON r.id=a.receipt_id WHERE (r.received_at AT TIME ZONE 'America/Bogota')::date<=days.day),0)
   -coalesce((SELECT sum(credit_reduction) FROM pos.sale_returns WHERE (created_at AT TIME ZONE 'America/Bogota')::date<=days.day),0) receivable
  FROM days LEFT JOIN items i ON i.day=days.day GROUP BY days.day
 ) SELECT jsonb_agg(jsonb_build_object('day',day,'sales',sales::text,'gross_profit',gross_profit::text,'net_profit',(gross_profit-expenses)::text,'expenses',expenses::text,'receivable',receivable::text) ORDER BY day) INTO trend FROM daily;
 financial:=financial||jsonb_build_object('trend',trend,'periods',(SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT substr(x->>'day',1,7) period,sum((x->>'sales')::numeric)::text sales,sum((x->>'expenses')::numeric)::text expenses FROM jsonb_array_elements(trend) x GROUP BY substr(x->>'day',1,7) ORDER BY 1) x));
 RETURN result||jsonb_build_object('financial',financial);
END $$;

DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pos' AND p.oid<>'pos.current_profile_auth_uid()'::regprocedure LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,pos_app',r.signature);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.cai_whatsapp_dispatch(text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,pos_app,pos_scheduler;
GRANT EXECUTE ON FUNCTION public.cai_whatsapp_dispatch(text,text,jsonb) TO anon;
DO $$ BEGIN EXECUTE format('SET LOCAL ROLE %I',current_setting('cai.v13_role')); END $$;
REVOKE CREATE ON SCHEMA pos,public FROM pos_owner;
NOTIFY pgrst,'reload schema';
COMMIT;
