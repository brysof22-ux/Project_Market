-- V1.4 additive metadata and read models; never resets operation.
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s';
SELECT set_config('cai.v14_role',current_user,true);
DO $$ BEGIN
 IF to_regclass('pos.notification_jobs') IS NULL THEN RAISE EXCEPTION 'MIGRATION_011_REQUIRED'; END IF;
 IF has_schema_privilege('pos_owner','pos','CREATE') OR has_schema_privilege('pos_owner','public','CREATE') THEN RAISE EXCEPTION 'REVIEW_OWNER_CREATE_PRIVILEGES'; END IF;
END $$;
GRANT CREATE ON SCHEMA pos,public TO pos_owner;
SET LOCAL ROLE pos_owner;
SELECT period_id FROM pos.operation_state WHERE id FOR UPDATE NOWAIT;
ALTER TABLE pos.cash_adjustments ADD COLUMN method text NOT NULL DEFAULT 'cash' CHECK(method IN ('cash','transfer')),
 ADD COLUMN purpose text NOT NULL DEFAULT 'operating' CHECK(purpose IN ('operating','capital','internal')),
 ADD COLUMN description text NOT NULL DEFAULT '' CHECK(length(description)<=500);
ALTER TABLE pos.cash_sessions ADD COLUMN opening_note text NOT NULL DEFAULT '' CHECK(length(opening_note)<=500);
ALTER TABLE pos.cash_closings ADD COLUMN note text NOT NULL DEFAULT '' CHECK(length(note)<=500);
ALTER TABLE pos.whatsapp_settings ADD COLUMN version integer NOT NULL DEFAULT 1;
DO $$ DECLARE def text; signature text; BEGIN
 def:=pg_get_functiondef('pos.operations_v1(text,jsonb,text)'::regprocedure);
 def:=replace(def,'FROM pos.cash_adjustments WHERE session_id=s.id','FROM pos.cash_adjustments WHERE method=''cash'' AND session_id=s.id');
 def:=replace(def,'opening_float,opened_at)','opening_float,opened_at,opening_note)');
 def:=replace(def,'v_actor,v_amount,v_now);','v_actor,v_amount,v_now,coalesce(p_data->>''note'',''''));');
 def:=replace(def,'difference,created_by) VALUES(v_id,v_session,v_expected,v_counted,v_counted-v_expected,v_actor)',
  'difference,created_by,note) VALUES(v_id,v_session,v_expected,v_counted,v_counted-v_expected,v_actor,coalesce(p_data->>''note'',''''))');
 def:=replace(def,'FROM pos.cash_adjustments WHERE session_id=v_session','FROM pos.cash_adjustments WHERE method=''cash'' AND session_id=v_session');
 EXECUTE def;
 FOREACH signature IN ARRAY ARRAY['pos.report_v1(jsonb)','public.cai_report(jsonb)'] LOOP
  def:=pg_get_functiondef(signature::regprocedure);
  def:=replace(def,'WHERE kind=''expense'' AND','WHERE kind=''expense'' AND purpose=''operating'' AND');
  def:=replace(def,'FROM pos.cash_adjustments a WHERE a.session_id=s.id','FROM pos.cash_adjustments a WHERE a.method=''cash'' AND a.session_id=s.id');
  EXECUTE def;
 END LOOP;
END $$;
CREATE FUNCTION pos.cash_expected_v14(p_id uuid) RETURNS numeric LANGUAGE sql STABLE SET search_path=pg_catalog,pos,pg_temp AS $$
 SELECT opening_float+coalesce((SELECT sum(amount) FROM pos.cash_entries WHERE session_id=s.id),0)
 +coalesce((SELECT sum(amount) FROM pos.cash_adjustments WHERE session_id=s.id AND method='cash'),0) FROM pos.cash_sessions s WHERE s.id=p_id
$$;
CREATE VIEW pos.finance_ledger_v14 WITH (security_invoker=true) AS
 SELECT p.id,s.cash_session_id session_id,p.created_at,s.created_by,p.amount,m.code method,'sale'::text kind,'Venta V-'||s.number concept,''::text description,'sale'::text purpose
 FROM pos.payments p JOIN pos.payment_methods m ON m.id=p.method_id JOIN pos.sales s ON s.id=p.sale_id
 UNION ALL SELECT r.id,r.cash_session_id,r.received_at,r.received_by,r.amount,m.code,'receipt','Abono de crédito','','receipt'
 FROM pos.credit_receipts r JOIN pos.payment_methods m ON m.id=r.method_id
 UNION ALL SELECT a.id,a.session_id,a.created_at,a.created_by,a.amount,a.method,a.kind,a.reason,a.description,a.purpose FROM pos.cash_adjustments a
 UNION ALL SELECT r.id,r.session_id,r.created_at,r.created_by,-r.refund_amount,m.code,'refund','Devolución',r.reason,'refund'
 FROM pos.sale_returns r JOIN pos.payment_methods m ON m.id=r.refund_method_id WHERE r.refund_amount>0 AND NOT m.affects_cash;
REVOKE ALL ON pos.finance_ledger_v14 FROM PUBLIC,anon,authenticated,service_role,pos_app,pos_scheduler;
ALTER FUNCTION public.cai_operations(text,jsonb,text) SET SCHEMA pos;
ALTER FUNCTION pos.cai_operations(text,jsonb,text) RENAME TO operations_v13;
REVOKE ALL ON FUNCTION pos.operations_v13(text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,pos_app,pos_scheduler;
CREATE FUNCTION public.cai_operations(p_action text,p_data jsonb DEFAULT '{}',p_key text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE actor uuid:=pos.current_profile_auth_uid(); role_name text; result jsonb; v_session_rec pos.cash_sessions;
 lim integer:=coalesce((p_data->>'limit')::integer,20); off integer:=coalesce((p_data->>'offset')::integer,0);
 day date:=(pos.business_now() AT TIME ZONE 'America/Bogota')::date; dfrom date; dto date; v_amount numeric;
 v_method text; v_purpose text; v_kind text; entity uuid; rev integer;
BEGIN
 role_name:=pos.require_staff(actor);
 IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR octet_length(p_data::text)>32768 THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
 IF lim NOT BETWEEN 1 AND 100 OR off NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'INVALID_PAGINATION' USING ERRCODE='22023'; END IF;
 IF p_action IN ('sales.today','finance.list','finance.summary','cash.history','cash.detail','cash.move','settings.save','whatsapp.settings') AND role_name<>'admin' THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF p_action='sales.today' THEN
  WITH source AS (
   SELECT s.id,s.number,s.created_at,s.total::text total,coalesce(nullif(s.buyer_name,''),c.name,'Consumidor final') customer,
    (SELECT coalesce(sum(quantity),0)::integer FROM pos.sale_items WHERE sale_id=s.id) products,
    coalesce((SELECT jsonb_agg(DISTINCT m.code) FROM pos.payments p JOIN pos.payment_methods m ON m.id=p.method_id WHERE p.sale_id=s.id),'[]'::jsonb)
     ||CASE WHEN b.principal>0 THEN '["credit"]'::jsonb ELSE '[]'::jsonb END methods,
    CASE WHEN r.id IS NOT NULL THEN 'returned' WHEN b.outstanding>0 THEN 'pending' ELSE 'completed' END status,r.id IS NOT NULL returned
   FROM pos.sales s LEFT JOIN pos.customers c ON c.id=s.customer_id LEFT JOIN pos.credit_charge_balances b ON b.sale_id=s.id LEFT JOIN pos.sale_returns r ON r.sale_id=s.id
   WHERE s.created_at>=(day::timestamp AT TIME ZONE 'America/Bogota') AND s.created_at<((day+1)::timestamp AT TIME ZONE 'America/Bogota')
  ), filtered AS (SELECT * FROM source WHERE (coalesce(p_data->>'search','')='' OR number::text ILIKE '%'||regexp_replace(p_data->>'search','^[vV]-','')||'%' OR customer ILIKE '%'||(p_data->>'search')||'%')
    AND (coalesce(p_data->>'method','all')='all' OR methods ? (p_data->>'method')) AND (coalesce(p_data->>'status','all')='all' OR status=p_data->>'status'))
  SELECT jsonb_build_object('day',day,'total',(SELECT count(*) FROM filtered),'rows',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT lim OFFSET off) x),'[]'::jsonb),
   'summary',jsonb_build_object('transactions',(SELECT count(*) FROM source),'net_sales',(SELECT public.cai_report(jsonb_build_object('from',day,'to',day))->>'net_sales'),
   'received',(SELECT public.cai_report(jsonb_build_object('from',day,'to',day))->>'collections'),
   'credit',(SELECT coalesce(sum(c.principal-coalesce(r.credit_reduction,0)),0)::text FROM pos.credit_charges c LEFT JOIN pos.sale_returns r ON r.charge_id=c.id WHERE c.created_at>=(day::timestamp AT TIME ZONE 'America/Bogota') AND c.created_at<((day+1)::timestamp AT TIME ZONE 'America/Bogota')))) INTO result;
  RETURN result;
 ELSIF p_action IN ('finance.list','finance.summary') THEN
  dfrom:=coalesce((p_data->>'from')::date,day);dto:=coalesce((p_data->>'to')::date,day);
  IF NOT isfinite(dfrom) OR NOT isfinite(dto) OR dfrom>dto OR dto-dfrom>365 THEN RAISE EXCEPTION 'INVALID_PERIOD' USING ERRCODE='22023'; END IF;
  WITH filtered AS (SELECT l.*,p.display_name responsible FROM pos.finance_ledger_v14 l JOIN pos.profiles p ON p.id=l.created_by
   WHERE l.created_at>=(dfrom::timestamp AT TIME ZONE 'America/Bogota') AND l.created_at<((dto+1)::timestamp AT TIME ZONE 'America/Bogota')
    AND (coalesce(p_data->>'session_id','')='' OR l.session_id=(p_data->>'session_id')::uuid))
  SELECT jsonb_build_object('business_day',day,'from',dfrom,'to',dto,'total',(SELECT count(*) FROM filtered),
   'rows',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT lim OFFSET off) x),'[]'::jsonb),
   'cash_in',coalesce(sum(amount) FILTER(WHERE method='cash' AND amount>0),0)::text,'cash_out',coalesce(-sum(amount) FILTER(WHERE method='cash' AND amount<0),0)::text,
   'transfer_in',coalesce(sum(amount) FILTER(WHERE method='transfer' AND amount>0),0)::text,'transfer_out',coalesce(-sum(amount) FILTER(WHERE method='transfer' AND amount<0),0)::text,
   'cash_balance',coalesce(sum(amount) FILTER(WHERE method='cash'),0)::text,'transfer_balance',coalesce(sum(amount) FILTER(WHERE method='transfer'),0)::text) INTO result FROM filtered;
  RETURN result;
 ELSIF p_action='cash.history' THEN
  PERFORM set_config('cai.reset_read','on',true);
  WITH filtered AS (SELECT s.*,p.display_name responsible,coalesce(c.expected,pos.cash_expected_v14(s.id)) expected,c.counted,c.difference,c.note closing_note FROM pos.cash_sessions s JOIN pos.profiles p ON p.id=s.operator_id LEFT JOIN pos.cash_closings c ON c.session_id=s.id
    WHERE (coalesce(p_data->>'from','')='' OR s.opened_at>=((p_data->>'from')::date::timestamp AT TIME ZONE 'America/Bogota'))
     AND (coalesce(p_data->>'to','')='' OR s.opened_at<(((p_data->>'to')::date+1)::timestamp AT TIME ZONE 'America/Bogota'))
     AND (coalesce(p_data->>'responsible','')='' OR p.display_name ILIKE '%'||(p_data->>'responsible')||'%')
     AND (coalesce(p_data->>'search','')='' OR s.id::text ILIKE '%'||(p_data->>'search')||'%' OR s.register_code ILIKE '%'||(p_data->>'search')||'%')
     AND (coalesce(p_data->>'status','all')='all' OR (p_data->>'status'='open' AND s.closed_at IS NULL) OR (p_data->>'status'='closed' AND s.closed_at IS NOT NULL)))
  SELECT jsonb_build_object('total',(SELECT count(*) FROM filtered),'rows',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM filtered ORDER BY opened_at DESC,id LIMIT lim OFFSET off) x),'[]'::jsonb)) INTO result;
  PERFORM set_config('cai.reset_read','',true);RETURN result;
 ELSIF p_action='cash.detail' THEN
  PERFORM set_config('cai.reset_read','on',true);
  SELECT * INTO v_session_rec FROM pos.cash_sessions WHERE id=(p_data->>'id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'CASH_SESSION_NOT_OPEN'; END IF;
  SELECT to_jsonb(v_session_rec)||jsonb_build_object('responsible',(SELECT display_name FROM pos.profiles WHERE id=v_session_rec.operator_id),'expected',coalesce(c.expected,pos.cash_expected_v14(v_session_rec.id)),
   'counted',c.counted,'difference',c.difference,'closing_note',c.note,
   'sales_cash',coalesce((SELECT sum(amount) FROM pos.cash_entries WHERE session_id=v_session_rec.id AND payment_id IS NOT NULL),0)::text,
   'receipts_cash',coalesce((SELECT sum(amount) FROM pos.cash_entries WHERE session_id=v_session_rec.id AND receipt_id IS NOT NULL),0)::text,
   'extra_cash',coalesce((SELECT sum(amount) FROM pos.cash_adjustments WHERE session_id=v_session_rec.id AND method='cash' AND amount>0),0)::text,
   'out_cash',coalesce((SELECT -sum(amount) FROM pos.cash_adjustments WHERE session_id=v_session_rec.id AND method='cash' AND amount<0),0)::text,
   'transfers',coalesce((SELECT sum(amount) FROM pos.finance_ledger_v14 WHERE session_id=v_session_rec.id AND method='transfer'),0)::text,
   'movements_total',(SELECT count(*) FROM pos.finance_ledger_v14 WHERE session_id=v_session_rec.id),
   'movements',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT l.*,p.display_name responsible FROM pos.finance_ledger_v14 l JOIN pos.profiles p ON p.id=l.created_by WHERE session_id=v_session_rec.id ORDER BY created_at DESC,id LIMIT lim OFFSET off) x),'[]'::jsonb)) INTO result
   FROM (SELECT 1) seed LEFT JOIN pos.cash_closings c ON c.session_id=v_session_rec.id;
  PERFORM set_config('cai.reset_read','',true);RETURN result;
 ELSIF p_action='cash.move' THEN
  PERFORM pos.require_period(p_data);
  result:=pos.begin_request(actor,'v14.cash.move',p_key,p_data);IF result IS NOT NULL THEN RETURN result; END IF;
  PERFORM pos.lock_cash_session(actor,(p_data->>'session_id')::uuid);
  v_amount:=(p_data->>'amount')::numeric;PERFORM pos.require_amount(v_amount);
  v_method:=coalesce(p_data->>'method','cash');v_purpose:=coalesce(p_data->>'purpose','operating');v_kind:=p_data->>'kind';
  IF v_method NOT IN ('cash','transfer') OR v_purpose NOT IN ('operating','capital','internal') OR v_kind IS NULL OR v_kind NOT IN ('income','expense') OR nullif(btrim(p_data->>'reason'),'') IS NULL OR length(p_data->>'reason')>500 OR length(coalesce(p_data->>'description',''))>500 THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
  IF p_data->>'date' IS NOT NULL AND (p_data->>'date')::date<>day THEN RAISE EXCEPTION 'INVALID_PERIOD' USING ERRCODE='22023'; END IF;
  IF v_kind='expense' THEN
   IF v_method='cash' AND v_amount>pos.cash_expected_v14((p_data->>'session_id')::uuid) THEN RAISE EXCEPTION 'INSUFFICIENT_CASH'; END IF;
   v_amount:=-v_amount;
  END IF;
  INSERT INTO pos.cash_adjustments(session_id,amount,kind,reason,created_by,method,purpose,description) VALUES((p_data->>'session_id')::uuid,v_amount,v_kind,btrim(p_data->>'reason'),actor,v_method,v_purpose,coalesce(p_data->>'description','')) RETURNING id INTO entity;
  INSERT INTO pos.audit_events(actor_id,action,entity_id) VALUES(actor,'cash.move',entity);
  result:=jsonb_build_object('id',entity);
  INSERT INTO pos.idempotency_requests VALUES(actor,'v14.cash.move',p_key,p_data,result,pos.business_now());RETURN result;
 ELSIF p_action='cash.close' AND p_data ? 'expected_cash' THEN
  PERFORM pos.require_period(p_data);
  result:=pos.begin_request(actor,'v11.operations.cash.close',p_key,p_data);IF result IS NOT NULL THEN RETURN result;END IF;
  PERFORM pos.lock_cash_session(actor,(p_data->>'session_id')::uuid);
  IF (p_data->>'expected_cash')::numeric IS DISTINCT FROM pos.cash_expected_v14((p_data->>'session_id')::uuid) THEN RAISE EXCEPTION 'VERSION_CONFLICT';END IF;
  RETURN pos.operations_v13(p_action,p_data,p_key);
 ELSIF p_action IN ('settings.save','whatsapp.settings') THEN
  PERFORM pos.require_period(p_data);
  PERFORM pg_advisory_xact_lock(hashtext('cai-market:settings:'||p_action));
  IF p_action='settings.save' THEN SELECT version INTO rev FROM pos.store_settings WHERE id FOR UPDATE;rev:=coalesce(rev,0);
  ELSE SELECT version INTO rev FROM pos.whatsapp_settings WHERE id FOR UPDATE;END IF;
  result:=pos.begin_request(actor,'v14.'||p_action,p_key,p_data);IF result IS NOT NULL THEN RETURN result;END IF;
  IF (p_data->>'version')::integer IS DISTINCT FROM rev THEN RAISE EXCEPTION 'VERSION_CONFLICT';END IF;
  result:=pos.operations_v13(p_action,p_data,p_key);
  IF p_action='whatsapp.settings' THEN UPDATE pos.whatsapp_settings SET version=version+1 WHERE id;END IF;
  INSERT INTO pos.idempotency_requests VALUES(actor,'v14.'||p_action,p_key,p_data,result,pos.business_now());RETURN result;
 END IF;
 result:=pos.operations_v13(p_action,p_data,p_key);
 IF p_action='bootstrap' THEN result:=result||jsonb_build_object('business_day',day);
 ELSIF p_action='whatsapp.status' THEN result:=jsonb_set(result,'{settings,version}',to_jsonb((SELECT version FROM pos.whatsapp_settings WHERE id)));
 ELSIF p_action='sales.detail' THEN
  SELECT result||jsonb_build_object('customer',coalesce(nullif(s.buyer_name,''),c.name,'Consumidor final'),
   'payments',coalesce((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('method',m.name)) FROM pos.payments p JOIN pos.payment_methods m ON m.id=p.method_id WHERE p.sale_id=s.id),'[]'::jsonb)) INTO result FROM pos.sales s LEFT JOIN pos.customers c ON c.id=s.customer_id WHERE s.id=(p_data->>'id')::uuid;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION pos.cash_expected_v14(uuid) FROM PUBLIC,anon,authenticated,service_role,pos_app,pos_scheduler;
REVOKE ALL ON FUNCTION public.cai_operations(text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,pos_app,pos_scheduler;
GRANT EXECUTE ON FUNCTION public.cai_operations(text,jsonb,text) TO authenticated;
DO $$ BEGIN EXECUTE format('SET LOCAL ROLE %I',current_setting('cai.v14_role'));END $$;
REVOKE CREATE ON SCHEMA pos,public FROM pos_owner;
NOTIFY pgrst,'reload schema';
COMMIT;
