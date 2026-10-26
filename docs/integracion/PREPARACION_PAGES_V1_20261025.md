# Pages V1: preparación de publicación definitiva

**Dictamen: preparación aprobada; publicación pendiente de autorización explícita.** Fecha: 25/10/2026 (Colombia). Proyecto Pages `cai-market`, dominio `https://project-market.pages.dev`, repositorio `brysof22-ux/Project_Market`, producción desde `main`. No se publicó frontend, no se hicieron commits/fusiones y no se modificaron Worker ni Supabase.

**Único cambio remoto de esta preparación:** se añadió `VITE_API_URL` al entorno **production** de Pages a las 22:21 Colombia. Se comparó la configuración completa preservada, incluyendo otras variables, preview, dominio, fuente Git, build y despliegue canónico: sin diferencias. No se creó ningún despliegue al actualizar esa variable.

## Resultados de pruebas

| Comprobación | Resultado |
| --- | --- |
| `npm run test:api` | **103/103 PASS** |
| `npm run check:api` | PASS, TypeScript del Worker/cliente/pruebas |
| `node node_modules/typescript/bin/tsc -b` | PASS, proyecto React y configuración Node/Vite |
| `npm run lint` | PASS, también después del nuevo comprobador de CSP |
| `npm run test:e2e -- --workers=1 --max-failures=1` | **41/41 PASS**, salida 0 |
| `npm run check:frontend-config` con variables reales de Pages | PASS |
| `npm run build` con `CF_PAGES_BRANCH=main` y variables reales de Pages | PASS: TypeScript + Vite producción |
| `node scripts/check-v1-build.mjs` | PASS, sin marcadores de demo/harness ni claves secretas del patrón comprobado |
| `node scripts/verify-frontend-artifact.mjs` | **7/7 PASS** en Chromium sobre `dist` con sus cabeceras reales |
| Análisis de credenciales/artefactos | PASS: sin claves privadas/PAT/cadenas PostgreSQL privadas ni JWT service_role detectados; destinos y rutas correctos |
| CORS del Worker publicado | PASS: tres OPTIONS con origen Pages exacto y métodos esperados |
| Análisis Git sin integrar | `main` es ancestro de V1; una confirmación por delante, cero por detrás, sin conflictos; dry-run del push: PASS |

La suite UI terminó todas sus comprobaciones sin fallos; su cierre quedó esperando al servidor Vite por las restricciones del entorno. Se identificó por PID y comando exactos y se cerró exclusivamente ese servidor local después de las 41 pruebas. Playwright terminó normalmente con salida 0. No se omitieron pruebas ni se modificaron timeouts/controles para conseguir el resultado.

Las pruebas UI usan Auth ficticia y UI → Worker real → RPC SQL en PGlite local. Incluyen permisos, expiración/cierre de sesión, navegación, inventario, POS, pagos y coherencia de datos. Las pruebas legacy de QR quedan en un harness separado. No se usaron JWT reales ni se ejecutaron operaciones comerciales contra producción. El comprobador CSP intercepta íntegramente las salidas remotas y solo responde a dos lecturas de salud sintéticas.

## Variables de producción verificadas

| Variable | Estado actual de Pages production |
| --- | --- |
| `VITE_SUPABASE_URL` | Exactamente `https://sauoekefntzxhqxycdgo.supabase.co`, conservada |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Publishable válida y exactamente igual a la del Worker operativo, conservada; valor omitido del informe |
| `VITE_API_URL` | **Añadida:** `https://cai-market-api.brysof22.workers.dev` |

Solo existen estas tres variables `VITE_*` en producción. No hay claves secretas, `service_role`, contraseñas PostgreSQL ni PAT bajo ese prefijo. Todas son `plain_text`; la publishable es pública por diseño y se incorpora al frontend. No se descargaron ni utilizaron credenciales administrativas para React.

La igualdad de la publishable de Pages y la del Worker publicado se comprobó mediante lecturas GET y comparación en memoria, sin imprimir sus valores ni cambiar ninguno de los servicios.

El build local utilizó en memoria los valores públicos consultados a Pages, con `CF_PAGES_BRANCH=main`, sin modificar `.env.local`. El guard de producción comprueba esos destinos, rechaza claves privadas/plantillas y cualquier otra variable `VITE_*`. El bloqueo `PREVIEW_BLOCKED` de la rama release se conserva y no afecta a `main`.

La actualización de variables se realizó con PATCH del proyecto Pages, únicamente `deployment_configs.production.env_vars`, conservando los valores existentes. Las huellas de toda la configuración salvo la nueva variable coincidieron antes/después. El deployment de producción canónico y el último deployment siguieron siendo los mismos. [API oficial de actualización de proyectos](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/edit/).

## Funcionalidades y ausencia de datos simulados

El grafo desde `src/main.tsx` conserva Dashboard/Estadísticas/reportes, inventario, POS/ventas/pagos, clientes, proveedores, créditos/cartera/abonos, caja/gastos/cierres, devoluciones, usuarios/permisos, auditoría y configuración. Las llamadas comerciales usan las RPC reales detrás del Worker; sin registros se muestran ceros y estados vacíos.

La revisión del grafo de importaciones encontró 32 archivos alcanzables y ninguna dependencia de `src/data/mock.ts`, las pantallas legacy de POS/módulos, tablas de venta demo o proveedores de simulación. Solo se reutiliza `payments/types.ts` para aritmética monetaria. Los archivos legacy se conservan para sus pruebas, pero no alimentan las pantallas comerciales V1. El build también pasó el control de marcadores y no incluye assets del harness ni QR demo. La carpeta vacía `demo-qr`, que Vite copia del árbol local, no contiene archivos y no aporta datos de prueba.

El artefacto contiene **17 archivos, 1.021.705 bytes**. Huella agregada de rutas, tamaños y SHA-256 individuales: `5aa44391c88cf6ca4b2b424514a2e8ca4b1f75ceea155803407d5b509cb4ae2e`. El manifiesto completo queda en `.cache/pages-v1-preparation/artifact-manifest.json`; no se versiona `dist`.

Se conservan los límites implementados de V1: devolución completa, confirmación manual de pagos y administración de perfiles de cuentas ya existentes en Auth. No se añade conciliación bancaria, QR remoto, ventas offline ni contabilidad tributaria por esta publicación.

## Compatibilidad, autenticación, navegación, CORS y CSP

El Worker activo se confirmó por GET en Cloudflare: **`84dea860-d785-4387-994b-9bac21126178` al 100 %**, sin modificación. El cliente React utiliza `/api/me`, `/api/catalog` y `/api/operations` con JWT original, JSON, clave idempotente cuando corresponde, `credentials: omit`, timeout, errores saneados y validación del contrato de respuesta. La validación de firma/expiración y la autorización siguen en Auth/Worker/PostgreSQL.

La UI exige sesión verificada y perfil propio activo antes de montar módulos. Se conservaron login, expiración, cierre entre pestañas, reintentos y navegación hash. Las diez rutas privadas permanecen detrás del login sin sesión; configuración exige administrador. Ningún error activa un usuario o datos de demostración como fallback.

CORS real del Worker: OPTIONS `/api/me` con GET y `/api/catalog`/`api/operations` con POST devolvieron 204 y `Access-Control-Allow-Origin: https://project-market.pages.dev`. No se amplió CORS ni se cambió código/configuración del Worker.

`public/_headers`, copiado exactamente a `dist/_headers`, establece:

- `connect-src 'self'` más exclusivamente Supabase original y el Worker autorizado; sin wildcard de Supabase ni destinos alternativos. No se usa Realtime y no hace falta `wss:`.
- Scripts y fuentes propios; sin `unsafe-eval`. Estilos inline permitidos por los componentes existentes; imágenes propias/data/blob.
- `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`, `nosniff`, DENY, referrer y permisos restringidos.

La prueba de Chromium sirvió el **build de producción** por loopback aplicando esas cabeceras, comprobó su recepción y verificó que CSP permite los dos destinos previstos y bloquea un tercero antes de enviar la petición. Esto evita confundir las pruebas Vite —que no sirven `_headers`— con una prueba de CSP. La recepción real de estas cabeceras en Pages se volverá a comprobar después de la publicación autorizada.

## Estado Git, configuración de Pages y reversión disponible

- **Commit actual de `main`, confirmado en GitHub y localmente:** [`27aa8c7bfbfafd853c789c0e347b1b63c0778ab1`](https://github.com/brysof22-ux/Project_Market/commit/27aa8c7bfbfafd853c789c0e347b1b63c0778ab1).
- Release local/remota preparada inicialmente: `385eb8aa66d0a771212c5bde24cbdd06005e820c`. Hay cambios locales de preparación **aún no confirmados**, necesarios para la validación de producción, CSP, comprobaciones y documentación. Publicar únicamente el commit release remoto antiguo no equivale a publicar este lote revisado.
- Comparación remota: una confirmación por delante de `main`, cero por detrás. `main` no estaba protegido en la consulta pública; el análisis `merge-tree` no encontró conflictos. No se ejecutó merge ni se escribió el índice.
- El conector GitHub disponible tiene acceso de lectura; el acceso de publicación por Git Credential Manager quedó comprobado mediante `git push --dry-run`, sin actualizar refs. Se seleccionó temporalmente la cuenta existente `brysof22-ux` con `-c credential.username=...`, resolviendo el selector de múltiples cuentas sin contraseñas ni cambios de configuración Git.
- Pages conserva GitHub `brysof22-ux/Project_Market`, rama `main`, despliegues automáticos de producción habilitados, build `npm run build`, salida `dist`, raíz del repositorio y dominio `project-market.pages.dev`.
- La política previa de previews sigue intacta. El procedimiento siguiente solo empuja `main`; no crea un proyecto ni publica una Preview.
- **Deployment de producción actual y destino concreto de rollback:** `c4caa6bd-9bf7-4209-a5d9-c37a5b5a186b`, exitoso, commit `27aa8c7b...`, URL histórica `https://c4caa6bd.project-market.pages.dev`. No confundir con el último intento de Preview fallido `44714e26-...`, que no es un destino válido de rollback de producción.

## Procedimiento exacto de publicación, todavía NO ejecutado

Antes de ejecutar, obtener autorización explícita que incluya **commit de los cambios preparados, integración en main, push y publicación automática de Pages**. Releer GitHub/Pages/Worker: deben mantener los commits, versión, variables y configuración anteriores. Detenerse si cambiaron o si alguna validación falla.

El manifiesto `.cache/pages-v1-preparation/integration-manifest.json` fija los archivos pendientes y sus huellas; `commit-paths.nul` limita el staging a esos archivos. El verificador rechaza cambios posteriores, secretos por nombre de archivo, una rama/HEAD distintos o un índice previamente ocupado. Si algo cambia, repetir revisión y pruebas apropiadas y regenerar el lote; no forzar el verificador.

Desde `E:\Project_CAI_Market`, **solo después de la autorización**:

```powershell
node .cache/pages-v1-preparation/prepare-integration.mjs --verify
if ($LASTEXITCODE -ne 0) { throw 'DETENER: lote preparado diferente' }

git add --pathspec-from-file=.cache/pages-v1-preparation/commit-paths.nul --pathspec-file-nul
if ($LASTEXITCODE -ne 0) { throw 'DETENER: staging fallido' }
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'DETENER: revisar staged' }
git diff --cached --stat
# Revisar que solo estén los archivos del manifiesto, sin credenciales ni artefactos.
git commit -m 'release: prepare CAI Market V1 production'
if ($LASTEXITCODE -ne 0) { throw 'DETENER: commit fallido' }

git -c credential.username=brysof22-ux -c credential.interactive=never fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'DETENER: acceso Git no disponible' }
if ((git rev-parse origin/main).Trim() -ne '27aa8c7bfbfafd853c789c0e347b1b63c0778ab1') {
  throw 'DETENER: main remoto cambió; repetir integración y revisión'
}
git switch main
if ($LASTEXITCODE -ne 0) { throw 'DETENER: no se pudo seleccionar main' }
git merge --ff-only release/cai-market-v1
if ($LASTEXITCODE -ne 0) { throw 'DETENER: no es integración fast-forward' }

# Este push inicia el build y despliegue automático de PRODUCCIÓN:
git -c credential.username=brysof22-ux -c credential.interactive=never push origin main:main
if ($LASTEXITCODE -ne 0) { throw 'DETENER: no reintentar forzando main' }
```

Guardar el nuevo SHA y el nuevo deployment ID. No ejecutar `wrangler pages deploy` además del push: produciría una publicación adicional y no es el procedimiento Git preparado. No se requiere desplegar el Worker ni ejecutar SQL, sincronizar esquemas, cambiar permisos o configurar secretos.

Esperar a que Pages confirme checkout del SHA nuevo, entorno production/main, build correcto y etapa deploy exitosa. Verificar `https://project-market.pages.dev`: bundle nuevo con destinos/rutas V1, cabeceras CSP/seguridad efectivas, navegación y login sin acceder a módulos privados anónimamente. Repetir sondas de API/CORS y realizar login con una cuenta autorizada sin exponer su JWT; consultar `/api/me`. No ejecutar ventas, abonos o devoluciones de prueba. Detener y evaluar reversión si hay errores críticos, destinos incorrectos, CSP que bloquea Auth/API, filtraciones o una regresión atribuible a la nueva interfaz.

## Reversión preparada

La recuperación rápida debe usar el deployment de producción exitoso **`c4caa6bd-9bf7-4209-a5d9-c37a5b5a186b`**, no reconstruir a ciegas el commit antiguo ni revertir bases de datos.

1. En Cloudflare: Workers & Pages → `cai-market` → Deployments → localizar ese deployment production exitoso → menú de acciones → **Rollback to this deployment** → confirmar, con autorización de reversión.
2. Alternativa automatizada ya preparada, **no ejecutada**:

```powershell
node .cache/pages-v1-preparation/rollback-pages.prepared.mjs --authorized-pages-rollback
```

El script limita la acción al proyecto/cuenta/destino anteriores, verifica primero que es un deployment de producción exitoso, llama al endpoint oficial de rollback y confirma el deployment canónico. Lee la sesión de Wrangler en memoria y no imprime tokens. Solo se comprobó su sintaxis; no se ensayó una reversión modificando el servicio.

3. Confirmar deployment canónico/alias, HTML, assets, login y ausencia de errores nuevos. Conservar los registros saneados y el SHA que provocó el problema. **No hacer más pushes a main** hasta preparar una corrección revisada: un push posterior puede desplegar de nuevo. El rollback de Pages no cambia el commit Git de `main`; la reconciliación posterior debe ser otro cambio autorizado, sin force-push.
4. Mantener Worker V1 y Supabase 001–008. No ejecutar rollback del Worker, migraciones inversas, restauraciones ni cambios de saldos por un fallo de frontend. Pages rollback tampoco deshace operaciones ya confirmadas ni cambia variables del proyecto. Los valores públicos actuales pueden permanecer para la siguiente corrección.

Cloudflare admite como destino un deployment de producción exitoso, no una Preview. [Procedimiento oficial de rollback](https://developers.cloudflare.com/pages/configuration/rollbacks/), [endpoint API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/rollback/).

## Riesgos y verificaciones pendientes

- No se dispone de una sesión válida de prueba: el login real y el perfil 200 contra el Supabase original siguen pendientes. Los mocks/UI locales y la comunicación Auth ya comprobada desde el Worker no sustituyen esa verificación. Debe hacerse con una cuenta autorizada antes de declarar el sistema completo operativo.
- CSP se comprobó realmente en navegador sobre el build local; falta volver a confirmar sus cabeceras en el dominio público después de publicar. No se relajó la política para superar pruebas.
- Vite advierte de un chunk de entrada de aproximadamente **505 kB** (147 kB gzip). No bloquea build ni pruebas; queda como observación de rendimiento móvil. No se aumentó el umbral para ocultarla.
- Los cambios de preparación siguen sin commit; el lote probado corresponde al árbol local y su manifiesto, no solo al SHA release remoto. Cualquier diferencia antes de publicar exige revisión. El servidor de build de Pages deberá reconstruir ese commit nuevo con las tres variables ya configuradas.

Nuevo archivo de prueba de esta preparación: `scripts/verify-frontend-artifact.mjs`. Se conservó el resto del código funcional V1 y se actualizaron enlaces de documentación. Evidencias saneadas en `.cache/pages-v1-preparation/` (ignorada): configuración antes/después, tests, build, manifiesto de artefactos, CORS, estado Git, staging preparado y rollback. No hay contraseñas ni tokens en este informe.

**Estado al terminar:** frontend preparado sin publicar; solo `VITE_API_URL` añadida remotamente; main/Worker/Supabase y despliegue actual de Pages conservados. Se solicita autorización para crear el commit revisado, integrar V1 en main y activar su publicación de producción.
