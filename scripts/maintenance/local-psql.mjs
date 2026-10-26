import { spawn } from 'node:child_process'
import crypto from 'node:crypto'

// Local Unix socket only. The caller must verify network=none before creating sessions.
export class LocalPsql {
  constructor(container, database, label) {
    if (!/^cai[-_a-z0-9]+$/.test(container) || !/^cai_[a-z0-9_]+$/.test(database)) throw new Error('LOCAL_TARGET_REQUIRED')
    this.buffer = ''; this.errors = ''; this.closed = false; this.pending = null
    this.child = spawn('docker', ['exec', '-i', container, 'psql', '-h', '/tmp', '-U', 'supabase_admin', '-d', database, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { windowsHide: true })
    this.child.stdout.on('data', data => { this.buffer += data; this.consume() })
    this.child.stderr.on('data', data => { this.errors += data })
    this.child.on('error', error => this.reject(error))
    this.child.on('close', code => { this.closed = true; this.reject(Object.assign(new Error('PSQL_CLOSED'), { code })) })
    this.label = label; this.database = database
  }
  reject(error) { if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null } }
  consume() {
    if (!this.pending) return
    const i = this.buffer.indexOf(this.pending.marker)
    if (i < 0) return
    const pending = this.pending
    const output = this.buffer.slice(0, i).trim()
    this.buffer = this.buffer.slice(i + pending.marker.length).replace(/^\r?\n/, '')
    this.pending = null; clearTimeout(pending.timer)
    if (/WARNING:/.test(this.errors.slice(pending.errorOffset))) pending.reject(new Error('SQL_WARNING'))
    else pending.resolve(output)
  }
  exec(sql) {
    if (this.pending || this.closed) return Promise.reject(new Error('SESSION_NOT_IDLE'))
    return new Promise((resolve, reject) => {
      const marker = 'CAI_DONE_' + crypto.randomUUID().replaceAll('-', '')
      const timer = setTimeout(() => { this.reject(new Error('CLIENT_QUERY_TIMEOUT')); this.child.kill() }, 130000)
      this.pending = { marker, timer, resolve, reject, errorOffset: this.errors.length }
      this.child.stdin.write(sql.trimEnd() + (sql.trimEnd().endsWith(';') ? '' : ';') + '\n\\echo ' + marker + '\n')
    })
  }
  async json(sql) { return JSON.parse(await this.exec(sql)) }
  async close() {
    if (!this.closed) { this.child.stdin.end('\\q\n'); await new Promise(resolve => this.child.once('close', resolve)) }
  }
}
