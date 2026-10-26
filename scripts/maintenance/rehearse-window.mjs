// LOCAL REHEARSAL ONLY. No Supabase HTTP, network PostgreSQL, login renewal or deployment.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LocalPsql } from './local-psql.mjs'

const [work, prep, container, dbPrefix = 'cai_window_v2'] = process.argv.slice(2)
if (!work || !prep || !container) throw new Error('REQUIRE_WORKDIR_PREFLIGHTDIR_LOCAL_CONTAINER')
if (!/^cai_window_[a-z0-9_]+$/.test(dbPrefix)) throw new Error('LOCAL_DATABASE_PREFIX_REQUIRED')
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const save = (name, value) => fs.writeFileSync(path.join(work, name + '.json'), JSON.stringify(value, null, 2))
const assert = (condition, code, details) => { if (!condition) throw Object.assign(new Error(code), { details }) }
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const qi = name => '"' + name.replaceAll('"', '""') + '"'
const ql = value => "'" + String(value).replaceAll("'", "''") + "'"
const sessions = []
const results = { probes: [], migrations: [], cases: [] }
const fenceStates = {}
let phase = 'isolation'
function docker(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 500000 })
  assert(r.status === 0, 'LOCAL_DOCKER_FAILED')
  return r.stdout
}
function normalizeAcl(value, owner, kind) {
  if (value === null) return [`${owner}=${kind === 'S' ? 'rwU' : kind === 'schema' ? 'UC' : 'arwdDxtm'}/${owner}`]
  assert(!value.includes('"'), 'UNSUPPORTED_QUOTED_ACL_REQUIRES_REVIEW')
  return value.slice(1, -1).split(',').sort()
}
function normPermissions(items) { return items.map(v => ({ ...v, acl: normalizeAcl(v.acl, v.owner, v.kind) })) }
async function session(db, label) {
  const s = new LocalPsql(container, db, label); sessions.push(s)
  await s.exec(`SET application_name=${ql('cai_window_v2_' + label)}; SET ROLE postgres; SET search_path=public; SET TIME ZONE 'UTC'; SET extra_float_digits=3; SET lock_timeout='5s'; SET statement_timeout='120s'`)
  s.pid = Number(await s.exec('SELECT pg_backend_pid()'))
  return s
}
let captureSql = fs.readFileSync(path.join(prep, 'state.sql'), 'utf8')
const historyRef = 'FROM ONLY "supabase_migrations"."schema_migrations"'
assert(captureSql.split(historyRef).length === 2, 'CAPTURE_HISTORY_PROJECTION_CHANGED')
captureSql = captureSql.replace(historyRef, historyRef + " WHERE version<='20261023000500'")
async function snapshot(s, label) {
  // A single autocommit SELECT. No BEGIN survives the response.
  const v = await s.json('BEGIN TRANSACTION READ ONLY;\n' + captureSql + ';\nCOMMIT;')
  v.table_hashes.sort((a, b) => (a.schema + '.' + a.name).localeCompare(b.schema + '.' + b.name))
  save(label, v); return v
}
async function idleAndUnlocked(observer, allowedPids, label) {
  const v = await observer.json(`SELECT json_build_object('sessions',(SELECT coalesce(json_agg(t),'[]') FROM (SELECT pid,state,xact_start FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' ORDER BY pid) t),'locks',(SELECT coalesce(json_agg(t),'[]') FROM (SELECT l.pid,c.relname,l.mode,l.granted FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pos' AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY l.pid,c.relname,l.mode) t),'prepared',(SELECT count(*) FROM pg_prepared_xacts WHERE database=current_database()))`)
  save(label, v)
  assert(Number(v.prepared) === 0 && v.locks.length === 0 && v.sessions.every(s => allowedPids.includes(s.pid) && s.state === 'idle' && s.xact_start === null), 'INCOMPATIBLE_TRANSACTIONS', v)
  return v
}
async function ownerTables(s) {
  const tables = await s.json(`SELECT json_agg(t) FROM (SELECT c.relname AS name,pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS acl,has_table_privilege('pos_owner',c.oid,'INSERT') AND has_table_privilege('pos_owner',c.oid,'UPDATE') AND has_table_privilege('pos_owner',c.oid,'DELETE') AND has_table_privilege('pos_owner',c.oid,'TRUNCATE') AS full_owner_dml,EXISTS(SELECT FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attacl IS NOT NULL) AS column_acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pos' AND c.relkind='r' ORDER BY c.relname) t`)
  assert(tables.every(t => t.owner === 'pos_owner' && t.full_owner_dml && !t.column_acl), 'NONSTANDARD_OWNER_OR_COLUMN_ACL')
  const inv = await s.json(`SELECT json_build_object('unsafe_owner',(SELECT count(*) FROM pg_roles WHERE rolname='pos_owner' AND (rolsuper OR rolcanlogin OR rolbypassrls OR rolcreaterole)),'owner_memberships',(SELECT count(*) FROM pg_auth_members WHERE member='pos_owner'::regrole),'unsafe_definers',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('pos','public') AND p.prosecdef AND p.proowner<>'pos_owner'::regrole AND p.oid<>'pos.current_profile_auth_uid()'::regprocedure),'unsafe_direct_roles',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN pg_roles r WHERE n.nspname='pos' AND c.relkind IN ('r','v') AND r.rolname IN ('anon','authenticated','service_role','pos_app','pos_scheduler') AND has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')),'additional_login_writers',(SELECT count(*) FROM pg_roles r WHERE r.rolcanlogin AND r.rolname NOT IN ('postgres','supabase_admin','cli_login_postgres') AND (pg_has_role(r.oid,'pos_owner','SET') OR EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pos' AND c.relkind='r' AND has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE'))))) AS info`)
  assert(Object.values(inv).every(v => Number(v) === 0), 'WRITER_INVENTORY_NOT_COVERED', inv)
  save(s.label+'_writer_inventory',inv)
  return tables
}
async function cut(s, tables) {
  const refs = tables.map(t => 'pos.' + qi(t.name)).join(',')
  save('acl_snapshot_'+s.database,{database:s.database,tables,capturedAt:new Date().toISOString()})
  // Brief drain and atomic ACL cut; COMMIT releases every table lock before DDL.
  await s.exec(`BEGIN; SET LOCAL ROLE pos_owner; LOCK TABLE ${refs} IN ACCESS EXCLUSIVE MODE NOWAIT; REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON ${refs} FROM pos_owner; REVOKE SELECT ON pos.idempotency_requests FROM pos_owner; COMMIT; SET ROLE postgres`)
  fenceStates[s.database]='active'; save('fence_states',fenceStates)
  const matrix = await s.json(`SELECT json_agg(t) FROM (SELECT c.relname,has_table_privilege('pos_owner',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') AS writes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pos' AND c.relkind='r' ORDER BY c.relname) t`)
  assert(matrix.every(r => !r.writes), 'FENCE_OWNER_DML_STILL_AVAILABLE')
  return matrix
}
async function restore(s, tables) {
  const refs = tables.map(t => 'pos.' + qi(t.name)).join(',')
  await s.exec(`BEGIN; SET LOCAL ROLE pos_owner; GRANT INSERT,UPDATE,DELETE,TRUNCATE ON ${refs} TO pos_owner; GRANT SELECT ON pos.idempotency_requests TO pos_owner; COMMIT; SET ROLE postgres`)
  const now = await ownerTables(s)
  for (const t of tables) {
    const other = now.find(x => x.name === t.name)
    assert(other && same(normalizeAcl(t.acl, t.owner, 'r'), normalizeAcl(other.acl, other.owner, 'r')), 'RESTORED_ACL_DIFF_' + t.name)
  }
  fenceStates[s.database]='restored'; save('fence_states',fenceStates)
}
const staff = (actor, body) => `BEGIN; SET LOCAL SESSION AUTHORIZATION authenticator; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims=${ql(JSON.stringify({ sub: actor, role: 'authenticated', exp: 4102444800 }))}; ${body}; ROLLBACK`
function denied(body) { return `DO $test$ BEGIN BEGIN ${body}; RAISE EXCEPTION 'WRITER_WAS_ALLOWED'; EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $test$` }
async function fixture(s, writer) {
  const f = { actor: crypto.randomUUID(), customer: crypto.randomUUID(), product: crypto.randomUUID(), cash: crypto.randomUUID() }
  await s.exec(`SET ROLE supabase_admin; BEGIN; INSERT INTO auth.users(id) VALUES('${f.actor}'); INSERT INTO pos.profiles(id,display_name,role) VALUES('${f.actor}','ENSAYO mantenimiento','admin'); INSERT INTO pos.customers(id,name) VALUES('${f.customer}','ENSAYO mantenimiento'); INSERT INTO pos.products(id,sku,name,price) VALUES('${f.product}','MAINT-V2','ENSAYO mantenimiento',100); INSERT INTO pos.inventory_balances(product_id,quantity) VALUES('${f.product}',10); INSERT INTO pos.cash_sessions(id,register_code,operator_id,opening_float) VALUES('${f.cash}','MAINT_V2','${f.actor}',1000); COMMIT; SET ROLE postgres`)
  f.method = (await s.json("SELECT json_build_object('id',id) FROM pos.payment_methods WHERE code='cash'")).id
  // Committed synthetic setup, before capturing the migration baseline.
  const commit = body => staff(f.actor, body).replace(/ROLLBACK$/, 'COMMIT')
  await writer.exec(commit(`SELECT pos.authorize_credit_limit('${f.actor}','${f.customer}',500,'ENSAYO','maintenance-limit')`))
  await writer.exec(commit(`SELECT pos.confirm_sale('${f.actor}','${f.customer}','${f.cash}','[{"product_id":"${f.product}","quantity":2}]','[{"method_id":"${f.method}","amount":"50"}]',true,'maintenance-old-sale')`))
  await writer.exec(commit(`SELECT pos.record_credit_receipt('${f.actor}','${f.customer}','${f.cash}',30,'${f.method}',NULL,'maintenance-old-receipt')`))
  await writer.exec(commit(`SELECT pos.set_whatsapp_contact('${f.actor}','${f.customer}','+573000000000')`))
  return f
}
async function probes(writer, f, stage, includePublic) {
  const cases = [
    ['sale', `PERFORM pos.confirm_sale('${f.actor}','${f.customer}','${f.cash}','[{"product_id":"${f.product}","quantity":1}]','[{"method_id":"${f.method}","amount":"100"}]',false,'denied-sale-${stage}')`],
    ['receipt', `PERFORM pos.record_credit_receipt('${f.actor}','${f.customer}','${f.cash}',10,'${f.method}',NULL,'denied-receipt-${stage}')`],
    ['limit', `PERFORM pos.authorize_credit_limit('${f.actor}','${f.customer}',600,'ENSAYO','denied-limit-${stage}')`],
    ['contact', `PERFORM pos.set_whatsapp_contact('${f.actor}','${f.customer}','+573000000001')`],
    ['consent', `PERFORM pos.record_communication_consent('${f.actor}','${f.customer}','+573000000000',true,'presencial','ENSAYO')`],
  ]
  if (includePublic >= 6) cases.push(['catalog', "PERFORM public.cai_catalog('customer.save','{\"name\":\"DENIED\"}','denied-catalog-" + stage + "')"])
  if (includePublic >= 7) for (const action of ['sale.confirm','credit.receipt','cash.open','cash.close','sale.return','cash.move','user.save','settings.save']) cases.push([action, `PERFORM public.cai_operations('${action}','{}','denied-${action}-${stage}')`])
  for (const [name, body] of cases) { await writer.exec(staff(f.actor, denied(body))); results.probes.push({ stage, name, denied: true, pid: writer.pid }) }
  await writer.exec(`BEGIN; SET LOCAL ROLE pos_scheduler; ${denied("PERFORM pos.enqueue_credit_reminders('2026-10-28 14:00Z')")}; ROLLBACK`)
  await writer.exec(`BEGIN; SET LOCAL ROLE pos_owner; ${denied("UPDATE pos.customers SET name=name")}; ROLLBACK`)
  results.probes.push({ stage, name: 'scheduler_and_raw_owner', denied: true, pid: writer.pid })
}
async function businessEqual(before, after) {
  assert(same(before.table_hashes, after.table_hashes), 'ORIGINAL_DATA_CHANGED')
  for (const key of ['catalog_stock','catalog_financial','catalog_ledgerTotals','catalog_sequences']) assert(same(before[key], after[key]), 'FINANCIAL_DIFF_' + key)
  assert(same(before.roles, after.roles) && same(before.memberships, after.memberships), 'ROLE_MEMBERSHIP_DIFF')
}
try {
  assert(path.isAbsolute(work) && fs.existsSync(work), 'PRIVATE_WORKDIR_REQUIRED')
  const host = JSON.parse(docker(['inspect','--format','{{json .HostConfig}}',container]))
  assert(host.NetworkMode === 'none' && Object.keys(host.PortBindings || {}).length === 0, 'CONTAINER_NOT_ISOLATED')
  const approved = JSON.parse(fs.readFileSync(path.join(prep,'comparison.json')))
  const migrations = approved.migrationHashes.map(v => {
    const file = path.join(root,'supabase/migrations',v.name+'.sql'), sql = fs.readFileSync(file,'utf8')
    assert(v.sameAsRehearsed && digest(fs.readFileSync(file)) === v.sha256, 'MIGRATION_HASH_DIFF')
    return { name:v.name, sql, sha256:v.sha256 }
  })
  phase = 'success_setup'
  const audit = await session(dbPrefix+'_success','audit'), migrate = await session(dbPrefix+'_success','migrator'), writer = await session(dbPrefix+'_success','writer')
  results.connections={auditPid:audit.pid,migratorPid:migrate.pid,writerPid:writer.pid}
  assert(new Set(Object.values(results.connections)).size===3,'CONNECTIONS_NOT_INDEPENDENT')
  const f = await fixture(audit,writer)
  const before = await snapshot(audit,'before')
  const frozen=JSON.parse(fs.readFileSync(path.join(prep,'current-state.json')))
  assert(same(before.catalog_functions,frozen.catalog_functions),'UNREVIEWED_FUNCTION_DEFINITION')
  assert(before.history.length === 5 && before.partial_functions.length === 0 && before.partial_relations.length === 0 && before.partial_columns.length === 0, 'NOT_CLEAN_BASELINE')
  assert(Number(before.catalog_financial[0].outstanding) === 120 && before.catalog_stock[0].quantity === 8, 'POSITIVE_FIXTURE_INVALID')
  const tables = await ownerTables(audit); save('original_owner_acls',tables)
  await idleAndUnlocked(audit,[migrate.pid,writer.pid],'pre_cut_idle')
  phase = 'atomic_acl_cut';save('fence_matrix',await cut(audit,tables))
  await idleAndUnlocked(audit,[migrate.pid,writer.pid],'post_cut_idle')
  await probes(writer,f,'before006',5)
  for (let i=0;i<3;i++) {
    const n=i+6;phase='migration_'+n
    await idleAndUnlocked(audit,[migrate.pid,writer.pid],'before_ddl_'+n)
    const start=Date.now()
    // Separate PostgreSQL backends: uncooperative RPC writer does not request any advisory lock.
    await Promise.all([migrate.exec(migrations[i].sql),probes(writer,f,'concurrent'+n,n-1)])
    await idleAndUnlocked(audit,[migrate.pid,writer.pid],'after_ddl_'+n)
    const after=await snapshot(audit,'after_'+n);await businessEqual(before,after)
    assert(after.history.length===n-1,'HISTORY_CHANGED_BEFORE_REGISTRATION')
    await probes(writer,f,'after'+n,n)
    await migrate.exec(fs.readFileSync(path.join(prep,'register_20261023000'+n+'00.prepared.sql'),'utf8'))
    const recorded=await snapshot(audit,'registered_'+n);await businessEqual(before,recorded)
    assert(recorded.history.length===n&&recorded.history.every((h,j)=>h.version===`20261023000${j+1}00`),'HISTORY_INVALID')
    results.migrations.push({version:n,sha256:migrations[i].sha256,committed:true,validated:true,registered:true,writerDispatchedConcurrently:true,durationMs:Date.now()-start})
    console.log(JSON.stringify({migration:n,status:'PASS',writerDenied:true,checkTransactionsEnded:true}))
  }
  phase='restore_after_success';await restore(audit,tables)
  const after=await snapshot(audit,'after_release');await businessEqual(before,after)
  for(const key of ['catalog_functions','catalog_constraints','catalog_indexes','catalog_triggers']) assert(before[key].every(a=>after[key].some(b=>same(a,b))),'ORIGINAL_CATALOG_DIFF_'+key)
  assert(same(before.default_acls,after.default_acls),'DEFAULT_ACL_CHANGED')
  const oldObjects=normPermissions(before.permissions),newObjects=normPermissions(after.permissions)
  assert(oldObjects.every(a=>newObjects.some(b=>same(a,b))),'OLD_PERMISSIONS_NOT_RESTORED')
  assert(same(before.policies,after.policies),'POLICIES_CHANGED')
  const auditSql=fs.readFileSync(path.join(root,'supabase/checks/v1_postmigration_integrity.sql'),'utf8')
  await audit.exec(auditSql)
  await idleAndUnlocked(audit,[migrate.pid,writer.pid],'released_success_idle')
  // Demonstrate normal RPC authorization works again; no business mutation.
  await writer.exec(staff(f.actor,`DO $$ BEGIN IF (public.cai_catalog('products.list','{}',NULL)->>'total')::integer<1 THEN RAISE EXCEPTION 'RESTORED_GATEWAY_FAILED'; END IF; END $$`))
  await audit.exec('SET ROLE pos_owner')
  const actualBalance=await audit.json(`SELECT json_build_object('outstanding',outstanding,'available',available) FROM pos.credit_account_balances WHERE customer_id='${f.customer}'`)
  await audit.exec('SET ROLE postgres')
  assert(Number(actualBalance.outstanding)===120&&Number(actualBalance.available)===380,'ACTUAL_CREDIT_VIEW_DIFF')
  const report=await writer.json(staff(f.actor,"SELECT public.cai_report('{}')"))
  assert(Number(report.net_sales)===200&&Number(report.collections)===80&&Number(report.outstanding)===120&&report.gross_profit===null,'REPORT_RECONCILIATION_FAILED')
  save('report_summary',{netSales:report.net_sales,collections:report.collections,outstanding:report.outstanding,grossProfit:report.gross_profit,actualBalance})
  results.cases.push({name:'success',status:'PASS',permissionsRestored:true,locksRemaining:0,positiveDebt:120,stock:8})

  const foreignReader=await session(dbPrefix+'_error','other_database_reader')
  await foreignReader.exec('BEGIN; SELECT 1 FROM pos.customers WHERE false')
  await idleAndUnlocked(audit,[migrate.pid,writer.pid],'unrelated_database_lock_ignored')
  await foreignReader.exec('ROLLBACK');await foreignReader.close()
  results.cases.push({name:'other_database_reader',status:'PASS',databaseScopedLocks:true,locksRemaining:0})

  phase='handled_error_case'
  const ea=await session(dbPrefix+'_error','error_audit'),em=await session(dbPrefix+'_error','error_migrator'),eb=await session(dbPrefix+'_error','blocker')
  const et=await ownerTables(ea);await cut(ea,et)
  await eb.exec('BEGIN; SELECT 1 FROM pos.customers WHERE false')
  let detected=false
  try {await idleAndUnlocked(ea,[em.pid,eb.pid],'expected_incompatible_lock')} catch(e){assert(e.message==='INCOMPATIBLE_TRANSACTIONS','UNEXPECTED_NEGATIVE_TEST_ERROR');detected=true}
  assert(detected,'DID_NOT_STOP_FOR_UNEXPECTED_LOCK');await eb.exec('ROLLBACK');await restore(ea,et)
  const es=await snapshot(ea,'handled_error_release');assert(es.history.length===5&&es.partial_functions.length===0&&es.partial_relations.length===0,'ERROR_CASE_CHANGED_SCHEMA')
  await idleAndUnlocked(ea,[em.pid,eb.pid],'released_error_idle')
  results.cases.push({name:'unexpected_transaction',status:'PASS',ddlNotStarted:true,permissionsRestored:true,locksRemaining:0})

  // A transaction that was already present must prevent even the ACL cut.
  phase='inflight_transaction_at_cut'
  await eb.exec('BEGIN; SELECT 1 FROM pos.customers WHERE false')
  let drainRejected=false
  try {await cut(ea,et)} catch {drainRejected=/could not obtain lock/.test(ea.errors)}
  assert(drainRejected,'INFLIGHT_TRANSACTION_WAS_NOT_REJECTED')
  await eb.exec('ROLLBACK')
  const drainRecovery=await session(dbPrefix+'_error','drain_recovery')
  const stillOriginal=await ownerTables(drainRecovery)
  assert(et.every(t=>stillOriginal.some(n=>n.name===t.name&&same(normalizeAcl(t.acl,t.owner,'r'),normalizeAcl(n.acl,n.owner,'r')))),'FAILED_CUT_CHANGED_ACLS')
  await idleAndUnlocked(drainRecovery,[em.pid,eb.pid],'failed_cut_released_locks')
  results.cases.push({name:'inflight_transaction_at_cut',status:'PASS',cutRolledBack:true,permissionsUnchanged:true,locksRemaining:0})

  phase='retained_observer_transaction'
  await drainRecovery.exec('BEGIN READ ONLY; SELECT 1 FROM pos.customers WHERE false')
  let ownLeakDetected=false
  try {await idleAndUnlocked(drainRecovery,[em.pid,eb.pid],'expected_observer_read_lock')} catch(e){assert(e.message==='INCOMPATIBLE_TRANSACTIONS','UNEXPECTED_OBSERVER_TEST_ERROR');ownLeakDetected=true}
  assert(ownLeakDetected,'OBSERVER_READ_LOCK_WAS_IGNORED')
  await drainRecovery.exec('ROLLBACK')
  await idleAndUnlocked(drainRecovery,[em.pid,eb.pid],'observer_read_lock_released')
  results.cases.push({name:'observer_retained_read_transaction',status:'PASS',originalBugDetected:true,ddlNotStarted:true,locksRemaining:0})

  phase='crash_recovery_case'
  const ca=await session(dbPrefix+'_crash','crash_control'),cw=await session(dbPrefix+'_crash','crash_writer')
  const cf=await fixture(ca,cw),ct=await ownerTables(ca)
  save('crash_original_owner_acls',{database:dbPrefix+'_crash',tables:ct})
  await cut(ca,ct);await ca.close()
  await probes(cw,cf,'after_control_disconnect',5)
  const recover=await session(dbPrefix+'_crash','recovery');await restore(recover,ct)
  await idleAndUnlocked(recover,[cw.pid],'released_crash_idle')
  results.cases.push({name:'controller_disconnect',status:'PASS',failedClosed:true,controlledRecoveryRestoredAcls:true,locksRemaining:0})
  save('result',{status:'PASS',...results,fenceStates,productionTouched:false,advisoryLockRequired:false,originalMigrationFilesChanged:false})
  console.log(JSON.stringify({status:'PASS',migrations:3,writerProbes:results.probes.length,cases:results.cases}))
} catch(error) {
  save('failure',{phase,code:error.message,details:error.details,...results,fenceStates,productionTouched:false})
  console.log(JSON.stringify({status:'STOPPED',phase,code:error.message,details:error.details}));process.exitCode=1
} finally {
  for(const s of sessions){fs.writeFileSync(path.join(work,s.label+'.stderr.log'),s.errors);try{await s.close()}catch{/* Local evidence is preserved; no remote cleanup. */}}
}
