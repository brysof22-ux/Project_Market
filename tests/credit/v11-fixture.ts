import { readFile } from 'node:fs/promises'
import { createDatabase } from './fixture'

export async function createV11Database() {
  const db = await createDatabase()
  await db.exec('SET ROLE credit_migrator')
  await db.exec(await readFile('supabase/migrations/20261025000900_v11_periods_permissions.sql', 'utf8'))
  await db.exec('RESET ROLE')
  return db
}
