// Real PostgreSQL, synthetic data only. Creates its own loopback-only cluster;
// never accepts a database URL, existing PGDATA, password or remote target.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'

const argument = process.argv.indexOf('--pg-bin')
assert(argument >= 0 && process.argv[argument + 1], 'Use --pg-bin <PostgreSQL bin directory>')
const bin = path.resolve(process.argv[argument + 1])
const executable = name => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''))
for (const name of ['initdb', 'pg_ctl', 'psql']) assert(fs.existsSync(executable(name)), `Missing ${name}`)
const directory = path.resolve('.cache', 'v11-concurrency-' + crypto.randomUUID())
fs.mkdirSync(directory, { recursive: true })
const data = path.join(directory, 'data')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const q = value => "'" + String(value).replaceAll("'", "''") + "'"
const j = value => q(JSON.stringify(value)) + '::jsonb'
const result = { synthetic_only: true, independent_connections: true, migrations: [], cases: [] }
let started = false
let port
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('PG')))
Object.assign(env, { PGHOST: '127.0.0.1', PGUSER: 'postgres', PGDATABASE: 'postgres', PGSSLMODE: 'disable' })
const invoke = (name, args, input) => {
  const output = spawnSync(executable(name), args, { input, encoding: 'utf8', windowsHide: true, env,
    ...(name === 'pg_ctl' ? { stdio: 'ignore' } : {}), timeout: 120_000, maxBuffer: 4_000_000 })
  assert(!output.error && output.status === 0, `${name} failed: ${output.stderr || output.error?.message}`)
  return (output.stdout ?? '').trim()
}
const psqlArgs = () => ['-X', '-qAt', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
const sql = text => invoke('psql', psqlArgs(), text)
const rpc = (action, body, key = crypto.randomUUID(), section = 'operations') =>
  `SELECT public.cai_${section}(${q(action)},${j(body)},${q(key)});`
const claims = actor => ({ sub: actor, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
  session_id: '80000000-0000-4000-8000-000000000001', amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] })
const staff = (actor, query) => `SET statement_timeout='12s'; SET lock_timeout='8s'; BEGIN; SET LOCAL SESSION AUTHORIZATION authenticator;
  SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims',${q(JSON.stringify(claims(actor)))},true); ${query} COMMIT;`
const value = (actor, query) => JSON.parse(sql(staff(actor, query)).split(/\r?\n/).filter(line => line.startsWith('{')).at(-1))
const currentPeriod = () => sql('SELECT period_id FROM pos.operation_state WHERE id;')
const mutate = (actor, action, body, key, section) => value(actor, rpc(action, { ...body, expected_period: currentPeriod() }, key, section))
const newId = () => crypto.randomUUID()
const actorA = newId(), actorB = newId()
let cashMethod

function launch(label, actor, query, hold) {
  const child = spawn(executable('psql'), psqlArgs(), { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = '', err = '', done = false
  const completion = new Promise(resolve => {
    child.stdout.on('data', bytes => { out += bytes })
    child.stderr.on('data', bytes => { err += bytes })
    child.on('error', error => { err += error.message })
    child.on('close', code => { done = true; resolve({ code, out, err, pid: Number(out.match(/PID:(\d+)/)?.[1]) }) })
  })
  const body = `SET application_name=${q(label)}; SELECT 'PID:'||pg_backend_pid(); ${query} ${hold ? 'SELECT pg_sleep(2);' : ''}`
  child.stdin.end(actor ? staff(actor, body) : `BEGIN; SET statement_timeout='12s'; SET lock_timeout='8s'; ${body} COMMIT;`)
  return { completion, finished: () => done }
}

async function pair(label, actor1, query1, actor2, query2, expected, nowait = false) {
  const first = launch('cai_v11_' + label + '_a', actor1, query1, true)
  let held = false
  for (let attempt = 0; attempt < 50; attempt++) {
    await sleep(40)
    held = sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name=${q('cai_v11_' + label + '_a')} AND wait_event='PgSleep';`) === '1'
    if (held || first.finished()) break
  }
  assert(held, `${label}: first connection did not hold its transaction`)
  const second = launch('cai_v11_' + label + '_b', actor2, query2, false)
  let blocked = false
  if (!nowait) for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(25)
    blocked = Number(sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name=${q('cai_v11_' + label + '_b')} AND cardinality(pg_blocking_pids(pid))>0;`)) > 0
    if (blocked || second.finished()) break
  }
  const [a, b] = await Promise.all([first.completion, second.completion])
  assert.equal(a.code, 0, `${label}: first transaction failed: ${a.err}`)
  assert(a.pid && b.pid && a.pid !== b.pid, `${label}: connections must be independent`)
  if (expected === 'OK') assert.equal(b.code, 0, `${label}: second transaction failed: ${b.err}`)
  else assert(b.code !== 0 && b.err.includes(expected), `${label}: expected ${expected}: ${b.err}`)
  if (!nowait) assert(blocked, `${label}: did not observe real row blocking`)
  result.cases.push({ name: label, passed: true, first_pid: a.pid, second_pid: b.pid, blocking_observed: blocked, rejection: expected })
  console.log(JSON.stringify(result.cases.at(-1)))
}

const amount = query => Number(sql(query))
const session = actor => mutate(actor, 'cash.open', { opening_float: '5000', register_code: 'V11-' + actor.slice(0, 8) }).id
const product = (label, stock = 10) => mutate(actorA, 'product.save', { name: label, price: '100', purchase_price: '60', minimum: 0, quantity: stock, expected_stock: 0 }, undefined, 'catalog').id
const saleBody = (sessionId, productId, finance = false) => ({ session_id: sessionId, finance, expected_total: '100.00',
  customer_name: 'Persona ficticia', customer_phone: '3000000000', lines: [{ product_id: productId, quantity: 1 }],
  payments: finance ? [] : [{ method_id: cashMethod, amount: '100' }], expected_period: currentPeriod() })

try {
  // The cluster is new, bound only to loopback and contains no imported backup.
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  await new Promise(resolve => server.close(resolve))
  invoke('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8'])
  fs.appendFileSync(path.join(data, 'postgresql.conf'), `\nlisten_addresses='127.0.0.1'\nport=${port}\nmax_connections=20\n`)
  started = true
  invoke('pg_ctl', ['-D', data, '-l', path.join(directory, 'server.log'), '-w', 'start'])
  result.version = sql('SELECT version();')
  sql(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT
      coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    CREATE ROLE authenticator NOLOGIN NOINHERIT; GRANT authenticated TO authenticator;
    CREATE ROLE credit_migrator NOLOGIN CREATEROLE NOSUPERUSER;
    GRANT CREATE ON DATABASE postgres TO credit_migrator;
    GRANT USAGE ON SCHEMA auth TO credit_migrator;
    GRANT USAGE,CREATE ON SCHEMA public TO credit_migrator WITH GRANT OPTION;
    GRANT REFERENCES ON auth.users TO credit_migrator;
    CREATE SCHEMA supabase_migrations AUTHORIZATION credit_migrator;
    CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY, statements text[], name text);
    ALTER TABLE supabase_migrations.schema_migrations OWNER TO credit_migrator;`)
  for (const name of fs.readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort()) {
    const content = fs.readFileSync(path.join('supabase/migrations', name), 'utf8')
    sql('SET ROLE credit_migrator;\n' + content)
    const [version, ...description] = name.replace(/\.sql$/, '').split('_')
    sql(`SET ROLE credit_migrator; INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
      VALUES(${q(version)},${q(description.join('_'))},ARRAY[${q(content)}]);`)
    result.migrations.push({ name, sha256: crypto.createHash('sha256').update(content).digest('hex') })
  }
  sql(`INSERT INTO auth.users VALUES(${q(actorA)}),(${q(actorB)});
    INSERT INTO pos.profiles(id,display_name,role) VALUES(${q(actorA)},'Administrador ficticio','admin'),(${q(actorB)},'Cajero ficticio','cashier');
    INSERT INTO pos.payment_methods(code,name,affects_cash,requires_reference) VALUES('cash','Efectivo',true,false) ON CONFLICT(code) DO NOTHING;`)
  cashMethod = sql("SELECT id FROM pos.payment_methods WHERE code='cash';")
  const sessionA = session(actorA), sessionB = session(actorB)

  const last = product('Última unidad', 1)
  await pair('last_stock', actorA, rpc('sale.confirm', saleBody(sessionA, last)), actorB, rpc('sale.confirm', saleBody(sessionB, last)), 'INSUFFICIENT_STOCK')
  assert.equal(amount(`SELECT quantity FROM pos.inventory_balances WHERE product_id=${q(last)};`), 0)
  const repeated = product('Reintento venta')
  const sameSale = rpc('sale.confirm', saleBody(sessionB, repeated), 'v11-concurrent-sale-key')
  await pair('sale_retry', actorB, sameSale, actorB, sameSale, 'OK')
  assert.equal(amount(`SELECT count(*) FROM pos.sale_items WHERE product_id=${q(repeated)};`), 1)

  const creditProduct = product('Crédito concurrente')
  const financed = mutate(actorB, 'sale.confirm', saleBody(sessionB, creditProduct, true))
  const receipt = (amount, key) => rpc('debt.receipt', { charge_id: financed.charge_id, session_id: sessionB, method_id: cashMethod, amount, expected_period: currentPeriod() }, key)
  await pair('receipt_overpay', actorB, receipt('80', 'receipt-one'), actorB, receipt('80', 'receipt-two'), 'AMOUNT_EXCEEDS_DEBT')
  await pair('receipt_retry', actorB, receipt('20', 'receipt-same'), actorB, receipt('20', 'receipt-same'), 'OK')
  assert.equal(amount(`SELECT outstanding FROM pos.credit_charge_balances WHERE id=${q(financed.charge_id)};`), 0)

  const returnedProduct = product('Devolución concurrente')
  const sold = mutate(actorA, 'sale.confirm', saleBody(sessionA, returnedProduct))
  const returnBody = { sale_id: sold.sale_id, session_id: sessionA, method_id: cashMethod, reason: 'Devolución ficticia', expected_period: currentPeriod() }
  await pair('double_return', actorA, rpc('sale.return', returnBody), actorA, rpc('sale.return', returnBody), 'SALE_ALREADY_RETURNED')
  assert.equal(amount(`SELECT quantity FROM pos.inventory_balances WHERE product_id=${q(returnedProduct)};`), 10)

  const closeBody = { session_id: sessionB, counted: '5200', expected_period: currentPeriod() }
  await pair('double_close', actorB, rpc('cash.close', closeBody), actorB, rpc('cash.close', closeBody), 'CASH_SESSION_NOT_OPEN')
  await pair('closed_cash_sale', actorA, rpc('cash.close', { session_id: sessionA, counted: '5100', expected_period: currentPeriod() }), actorA,
    rpc('sale.confirm', saleBody(sessionA, creditProduct)), 'CASH_SESSION_NOT_OPEN')

  const preview = value(actorA, rpc('reset.preview', { expected_period: currentPeriod() }))
  const beforePeriod = currentPeriod()
  const resetBody = { expected_period: beforePeriod, intent_id: preview.intent_id, confirmation: 'REINICIAR OPERACION', reason: 'Ensayo local de concurrencia' }
  // A real writer holds the same SHARE gate; reset must reject, not wait.
  await pair('reset_rejects_writer', actorA, rpc('settings.save', { name: 'Tienda ficticia', address: '', version: 1, expected_period: beforePeriod }), actorA,
    rpc('reset.confirm', resetBody), 'OPERATION_IN_PROGRESS', true)
  // Renew the preview because settings/version may have changed.
  const nextPreview = value(actorA, rpc('reset.preview', { expected_period: beforePeriod }))
  const resetQuery = rpc('reset.confirm', { ...resetBody, intent_id: nextPreview.intent_id }, 'v11-reset-once')
  await pair('writer_rejects_reset', actorA, resetQuery, actorB,
    rpc('cash.open', { opening_float: '0', expected_period: beforePeriod }), 'OPERATION_IN_PROGRESS', true)
  assert.notEqual(currentPeriod(), beforePeriod)
  assert.equal(amount('SELECT sum(quantity) FROM pos.inventory_balances WHERE operating_period_id=(SELECT period_id FROM pos.operation_state);'), 0)
  assert.equal(amount(`SELECT count(*) FROM pos.sales WHERE operating_period_id=${q(beforePeriod)};`), 4)
  assert.equal(amount('SELECT count(*) FROM pos.credit_charge_balances WHERE outstanding<0;'), 0)
  assert.equal(amount('SELECT count(*) FROM pos.cash_entries GROUP BY payment_id HAVING payment_id IS NOT NULL AND count(*)>1;') || 0, 0)
  // Replay after commit returns the original result without creating a period.
  const replay = value(actorA, resetQuery)
  assert.equal(replay.period_id, currentPeriod())
  assert.equal(amount('SELECT count(*) FROM pos.operating_periods;'), 2)
  // A failed transaction released its gate; a new-period writer now succeeds.
  const reopened = session(actorB)
  assert(reopened)
  assert.equal(amount("SELECT count(*) FROM pg_stat_activity WHERE datname='postgres' AND state='idle in transaction';"), 0)
  for (const migration of result.migrations) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join('supabase/migrations', migration.name), 'utf8')).digest('hex'), migration.sha256)
  result.passed = true
} catch (error) {
  result.passed = false
  result.failure = error.message
  process.exitCode = 1
} finally {
  if (started) {
    try { invoke('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']); result.cluster_stopped = true }
    catch { result.cluster_stopped = false; process.exitCode = 1 }
  }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: result.passed, cases: result.cases.length, report: path.join(directory, 'result.json'), stopped: result.cluster_stopped, ...(result.failure ? { failure: result.failure } : {}) }))
}
