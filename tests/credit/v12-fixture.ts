import { readFile } from 'node:fs/promises'
import { createV11Database } from './v11-fixture'
export async function createV12Database() {
 const db = await createV11Database()
 await db.exec('SET ROLE credit_migrator')
 await db.exec(await readFile('supabase/migrations/20261026001000_v12_transfer_qr.sql','utf8'))
 await db.exec('RESET ROLE')
 return db
}
