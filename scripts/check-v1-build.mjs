import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('dist')
const forbidden = ['demo-admin', 'Cajero de ejemplo', 'Banco principal · Demo',
  'ventas-simuladas', 'Datos simulados', '/tests/harness/']
let invalid = false
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (['demo-qr', 'tests', 'harness'].includes(entry.name) && (await readdir(file)).length > 0) {
        console.error(`Artefacto de demostración no permitido: ${path.relative(root, file)}`)
        invalid = true
      }
      await inspect(file)
    } else if (/\.(?:js|html)$/.test(entry.name)) {
      const source = await readFile(file, 'utf8')
      if (forbidden.some((marker) => source.includes(marker)) || /sb_secret_[A-Za-z0-9_-]{20,}/.test(source)) {
        // Never print matched contents or credential candidates.
        console.error(`Revisar contenido de producción: ${path.relative(root, file)}`)
        invalid = true
      }
    }
  }
}
try {
  await inspect(root)
  if (invalid) process.exitCode = 1
  else console.log('Bundle sin marcadores de demostración, harness ni claves secretas del patrón comprobado. No sustituye una auditoría de secretos.')
} catch {
  console.error('No se pudo revisar dist. Ejecuta primero npm run build.')
  process.exitCode = 1
}
