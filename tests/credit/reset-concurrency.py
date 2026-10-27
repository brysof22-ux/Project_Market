"""Optional native PostgreSQL proof. Only the verified local fixture on port 55433.
Never invokes a successful reset; an independent writer must reject confirmation.
"""
import json
from pathlib import Path
import subprocess
import time

root = Path(__file__).resolve().parents[2]
psql = root / '.cache/v11-tools/pgsql/bin/psql.exe'
expected_directory = (root / '.cache/v13-postgres/data').resolve()
base = [str(psql), '-h', '127.0.0.1', '-p', '55433', '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']
flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)

def query(sql, required=True):
    result = subprocess.run(base + ['-c', sql], capture_output=True, text=True, encoding='utf8', creationflags=flags)
    if required and result.returncode:
        raise RuntimeError('Local fixture query failed; inspect isolated PostgreSQL logs.')
    return result

actual = Path(query("SELECT current_setting('data_directory')").stdout.strip()).resolve()
assert actual == expected_directory, 'LOCAL_FIXTURE_REQUIRED'
assert query("SELECT position('WHERE %I IS NOT NULL' in prosrc)>0 FROM pg_proc WHERE oid='pos.purge_operation(jsonb,uuid)'::regprocedure").stdout.strip() == 't', 'MIGRATION_013_REQUIRED'
actor = '10000000-0000-0000-0000-000000000002'
period = query('SELECT pos.current_period()').stdout.strip()
claims = {'sub': actor, 'role': 'authenticated', 'exp': 4102444800, 'session_id': '90000000-0000-4000-8000-000000000001', 'amr': [{'method': 'password', 'timestamp': int(time.time())}]}
prefix = "BEGIN;SET SESSION AUTHORIZATION authenticator;SET LOCAL ROLE authenticated;SELECT set_config('request.jwt.claims','" + json.dumps(claims) + "',true);"
def call(action, payload, key):
    data = json.dumps({'expected_period': period, **payload}).replace("'", "''")
    return "SELECT public.cai_operations('" + action + "','" + data + "','" + key + "');"

preview = json.loads(query(prefix + call('reset.preview', {}, 'native-preview') + 'COMMIT;').stdout.strip().splitlines()[-1])
before = query('SELECT md5(pos.reset_snapshot_v13()::text)').stdout.strip()
lock = subprocess.Popen(base, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf8', creationflags=flags)
try:
    lock.stdin.write("BEGIN;SELECT period_id FROM pos.operation_state WHERE id FOR SHARE;SELECT 'LOCKED';SELECT pg_sleep(3);COMMIT;\n")
    lock.stdin.close()
    while True:
        line = lock.stdout.readline()
        if not line:
            raise RuntimeError('Could not acquire isolated concurrency fixture lock.')
        if line.strip() == 'LOCKED':
            break
    request = {'intent_id': preview['intent_id'], 'confirmation': 'ELIMINAR OPERACION', 'reason': 'Native isolated contention check'}
    result = query(prefix + call('reset.confirm', request, 'native-busy-' + str(time.time_ns())) + 'COMMIT;', False)
    assert result.returncode and 'OPERATION_IN_PROGRESS' in result.stderr, 'EXPECTED_EXCLUSIVE_GUARD_REJECTION'
finally:
    lock.wait(timeout=10)
after = query('SELECT md5(pos.reset_snapshot_v13()::text)').stdout.strip()
assert before == after, 'LOCAL_ROWS_CHANGED'
print(json.dumps({'status': 'PASS', 'localDirectoryVerified': True, 'concurrentResetRejected': True, 'rowsUnchanged': True, 'successfulResetInvoked': False}))
