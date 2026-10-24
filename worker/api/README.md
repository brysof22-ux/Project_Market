# CAI Market API — perfil autenticado

**Estado local V1:** también existen `/api/catalog` y `/api/operations`, con RPCs de catálogo, operaciones y reportes propuestas en 006–008. Auth/RPC usan ahora `redirect: manual` y rechazan 3xx por incompatibilidad comprobada de workerd con `error`. La guía vigente de funciones, configuración, límites y publicación está en [ENTREGA_V1](../../docs/ENTREGA_V1.md). Este documento conserva la revisión histórica de la integración inicial; no implica que los cambios estén publicados.

Implementación local para el Worker **existente** `cai-market-api`, URL prevista `https://cai-market-api.brysof22.workers.dev`. No se creó otro Worker, no se desplegó código ni se aplicó SQL remoto. No utiliza Docker, contraseñas PostgreSQL ni `service_role`.

Revisión actual, diagnóstico publicado, binding R2, comandos completos de Worker/Pages y ensayo real: [auditoría de integración](../../docs/integracion/AUDITORIA.md). La versión pública comprobada el 23/10/2026 todavía no implementa el contrato local; devolver 200 en texto no demuestra que `/api/me` funcione.

## Flujo y contrato

1. React obtiene la sesión actual del cliente Supabase y envía su JWT original en `Authorization: Bearer <token>` a `GET /api/me`.
2. El Worker consulta `GET <SUPABASE_URL>/auth/v1/user` con ese JWT y la clave pública. **Supabase Auth verifica firma, expiración y usuario.** No se confía en una decodificación local ni en IDs enviados por el navegador.
3. Solo después de validarlo, invoca `POST /rest/v1/rpc/cai_current_profile` con el mismo JWT, `Content-Profile: public` y cuerpo `{}`. Nunca cambia el token por una clave privilegiada.
4. La RPC sin argumentos usa `auth.uid()` y solo lee el perfil propio activo. `pos` continúa fuera de los esquemas expuestos de Data API.
5. El Worker comprueba la coincidencia entre perfil y usuario validado y proyecta exclusivamente estos campos:

```json
{
  "id": "UUID_DEL_USUARIO_VALIDADO",
  "display_name": "Nombre del empleado",
  "role": "admin",
  "active": true
}
```

`GET /health` devuelve únicamente `{"status":"ok"}`; no comprueba PostgreSQL, claves o existencia de empleados. No es una prueba de conectividad de Supabase.

| Respuesta | Significado |
| --- | --- |
| 200 | Perfil propio activo, o health correcto |
| 401 | Bearer ausente/malformado, token rechazado por Auth o JWT rechazado por RPC |
| 403 | Perfil ausente/inactivo, origen o preflight no autorizado |
| 404 | Ruta desconocida |
| 405 | Método no admitido; cabecera `Allow: GET, OPTIONS` |
| 502 | Respuesta de servicio malformada o identidad del perfil incorrecta |
| 503 | Configuración, red, Auth o RPC no disponibles |

Los errores tienen forma `{"error":{"code":"...","message":"..."}}`, sin cuerpos SQL/Auth, trazas, correos adicionales, contraseñas o tokens. Un permiso RPC mal configurado se trata como indisponibilidad, no como prueba de que el usuario no tiene perfil. No hay logs de credenciales. Todas las respuestas usan `Cache-Control: no-store`.

Las subconsultas a Auth/PostgREST también desactivan caché y rechazan redirecciones, evitando reutilizar un perfil o reenviar el Bearer a otro destino.

## Revisión de la nueva migración

Archivo: `supabase/migrations/20261023000500_current_profile_rpc.sql`. Las cuatro migraciones anteriores no se editaron ni se reejecutan en Supabase.

- `public.cai_current_profile()` no tiene parámetros: no acepta `id`, `p_actor` ni un rol elegido por el cliente.
- `SECURITY DEFINER` es necesario para leer la tabla privada sin otorgar SELECT a empleados. Su propietario es `pos_owner`, que debe continuar NOLOGIN, sin superusuario, BYPASSRLS ni privilegios administrativos. Como ese rol posee las tablas, puede eludir RLS dentro de la función: por eso la consulta está cualificada y exige explícitamente `p.id = auth.uid()` y `active`.
- Fija `search_path = pg_catalog, pg_temp`; todas las referencias de negocio/Auth llevan esquema. No hay SQL dinámico ni escritura.
- Exige sesión del gateway `authenticator`, claims `authenticated` vigentes y coincidencia del sujeto con `auth.uid()`. Claims fabricados desde una conexión SQL directa no bastan. La firma se verifica en Auth/PostgREST; leer JSON en PostgreSQL no valida criptografía.
- Este límite requiere que ninguna otra RPC expuesta permita SQL arbitrario o alterar `request.jwt.claims`. Revisar las funciones públicas existentes antes de habilitar el flujo; una RPC que cambie el contexto del gateway comprometería también las validaciones financieras previas.
- Solo `authenticated` recibe EXECUTE. Se revoca para PUBLIC, anon, service_role y roles técnicos. No se conceden lecturas de ninguna tabla ni se altera `pos.require_staff`.
- Supabase alojado no permite a `postgres` delegar USAGE de `auth`. La 005 corregida usa `pos.current_profile_auth_uid()`, un puente privado SECURITY DEFINER propiedad del migrador que solo llama a `auth.uid()`, con EXECUTE únicamente para `pos_owner` (además de los privilegios inherentes del propietario/administradores). No concede permisos en auth. [Diagnóstico, riesgos y comandos de recuperación](../../docs/integracion/MIGRACION_005.md).
- CREATE sobre `public` se concede temporalmente para transferir la función a `pos_owner` y se revoca dentro de la misma transacción. Se aborta si ese rol ya tenía CREATE, para no retirar un permiso previo silenciosamente. El administrador necesita propiedad o permisos de creación con opción de concesión, y capacidad de SET al propietario existente.
- No cambia roles de empleados, tablas, políticas financieras, vencimientos, caja ni recordatorios. WhatsApp sigue simulado.
- Se notifica a PostgREST para recargar su caché. `public` debe estar expuesto en Data API; **no agregar `pos`**.

Se preparó `supabase/checks/current_profile_preflight.sql` (solo catálogos, sin datos personales). No se ejecutó contra Supabase. Aborta si 005 está registrada o hay RPC/helper previos; revisar también ACL, flags/membresías, propietarios/RLS y configuración Data API. Los administradores de base y la credencial del gateway son parte del límite de confianza; no concederlos al Worker ni a empleados.

## Variables

| Ubicación | Variable | Valor / uso |
| --- | --- | --- |
| Cloudflare Pages / Vite | `VITE_API_URL` | `https://cai-market-api.brysof22.workers.dev` |
| Pages / Vite | `VITE_SUPABASE_URL` | URL HTTPS del mismo proyecto Supabase |
| Pages / Vite | `VITE_SUPABASE_PUBLISHABLE_KEY` | Clave pública `sb_publishable_...` |
| Worker binding | `SUPABASE_URL` | URL HTTPS del proyecto; sin `/auth/v1` ni `/rest/v1` |
| Worker binding | `SUPABASE_PUBLISHABLE_KEY` | Clave pública del mismo proyecto; se puede guardar como secret binding |
| Worker vars | `ALLOWED_ORIGIN` | `https://project-market.pages.dev` (sin barra final) |
| Worker R2 | `MEDIA` | Bucket existente `cai-market-media`; declarado en Wrangler, sin API de medios todavía |

Se añadió `VITE_API_URL` a `.env.example` y, si faltaba, a `.env.local`, conservando los valores existentes. Las variables `VITE_*` son públicas y se incorporan al build: cambiar la configuración de Pages requiere reconstruir el frontend. No colocar allí claves secretas ni contraseñas.

Al revisar el archivo local guardado en disco, faltaban ambas variables de Supabase; solo quedó configurada la URL de API añadida. Guardar sus valores reales antes de un ensayo manual. No se inspeccionaron ni cambiaron las variables remotas de Pages o del Worker.

CORS compara el origen exacto, sin wildcard ni autorización automática de previews de Pages. Permite preflight GET con Authorization/Accept; devuelve los headers CORS también en errores al origen autorizado. Clientes sin Origin (por ejemplo curl) pueden consultar, pero `/api/me` sigue exigiendo el JWT. CORS no sustituye autenticación.

## Desarrollo local sin Docker

Revisar primero `worker/api/.dev.vars.example`, copiarlo como `worker/api/.dev.vars` y completar los valores públicos del proyecto. Estos archivos locales y `.wrangler` se ignoran en Git. El origen local debe ser exactamente el utilizado por Vite.

```powershell
# Terminal de API: ejecuta workerd local, no despliega.
npm run dev:api

# Otra terminal: sobrescribe solo en esta sesión la URL pública de .env.local.
$env:VITE_API_URL = 'http://127.0.0.1:8787'
npm run dev -- --host 127.0.0.1
```

Cerrar esa terminal o quitar su variable de entorno para volver al Worker alojado. Probar un login local contra Supabase real requiere que la nueva migración haya sido aplicada tras autorización. Si el Worker/RPC aún no está disponible, React muestra el error y mantiene los módulos bloqueados; no vuelve a permisos de demostración para conceder acceso.

`src/lib/api-client.ts` contiene el cliente HTTP probado y `src/lib/api.ts` lo conecta al SDK. `AuthProvider` guarda el perfil validado en memoria en `useAuth().profile` y lo elimina al cerrar/expirar la sesión. Un 401 exige volver a iniciar sesión; un 403 indica contactar al administrador sin atribuir permisos al usuario. El perfil no es una autorización financiera permanente: cada operación futura del backend deberá comprobar identidad y permisos nuevamente. El simulador de roles/QR sigue siendo local y no modifica el rol real.

## Comprobaciones locales

```powershell
npm run check:api
npm run test:api
npm run check:credit
npm run test:credit
npm run build
npm run lint
npm run test:e2e -- --workers=1 --max-failures=1

# Solo empaquetado local: no publica ni modifica el Worker.
npx --yes wrangler@4 deploy --dry-run --config worker/api/wrangler.jsonc --outdir worker/api/.dry-run
```

Ejecutar secuencialmente en equipos con poca memoria. Las pruebas API usan Request/Response y un transporte inyectado: simulan respuestas de Supabase y no verifican una firma contra el proyecto real. Las pruebas SQL cargan las cinco migraciones en PGlite con administrador sin superusuario, roles/Auth ficticios y perfiles ficticios; no emplean datos financieros reales. Playwright visual usa API y Auth interceptados con variables de prueba, no el Worker de producción. No representan validación end-to-end del despliegue remoto ni concurrencia PostgreSQL independiente.

En esta máquina C: no tenía espacio suficiente para npm/temporales y las ejecuciones paralelas agotaron memoria. Se completó la regresión visual con un único worker y temporales/caché dentro de `.cache` en E:, sin desactivar pruebas ni cambiar sus timeouts. Para usar esa alternativa en una terminal de PowerShell:

```powershell
$apiLocalTemp = Join-Path (Get-Location).Path '.cache\tmp'
New-Item -ItemType Directory -Path $apiLocalTemp -Force | Out-Null
$env:npm_config_cache = Join-Path (Get-Location).Path '.cache\npm'
$env:TEMP = $apiLocalTemp
$env:TMP = $apiLocalTemp
```

Son ajustes de esa terminal y sus procesos hijos, no del sistema. `.cache` está excluido de Git. El empaquetado local `--dry-run` se completó con **Wrangler 4.152.0**, con un bundle de 6,87 KiB; no publicó ningún Worker. Si la instalación de la herramienta necesita limitar descargas, usar `npm_config_maxsockets=1` en esa terminal. No se agregaron dependencias al proyecto.

Resultados finales de esta revisión:

| Comprobación | Resultado |
| --- | --- |
| Worker, cliente HTTP y configuración | 32 pruebas aprobadas |
| SQL/RPC y regresión financiera en PGlite | 59 pruebas aprobadas |
| Chromium: Auth/perfil, módulos y transferencias | 36 pruebas aprobadas |
| TypeScript de API/Worker y fixture de créditos | Correcto |
| Compilación TypeScript/Vite y lint | Correctos |
| Wrangler deploy --dry-run | Empaquetado local correcto; sin despliegue |
| Runtime workerd local, con MEDIA local | 6 comprobaciones HTTP correctas: health, JWT ausente/malformado, CORS, OPTIONS y método |
| Configuración pública del frontend | Pendiente: faltan las dos variables Supabase; no publicar el dist actual |
| HTTP público del Worker y bundle de Pages | Contrato no cumplido; requiere publicación del código local |
| SQL alojado y login del administrador real | No ejecutados; pendientes de autorización/configuración |

Archivos principales: `worker/api/src/index.ts`, `wrangler.jsonc` y `tsconfig.json`; migración 005 y `supabase/checks/current_profile_preflight.sql`; `shared/profile.ts`; clientes `src/lib/api-client.ts` y `api.ts`; integración en AuthProvider/contexto y guard de App; pruebas `tests/api`, `tests/credit/current-profile.spec.ts` y casos de perfil en `tests/auth.spec.ts`. Se actualizaron los fixtures/configuraciones de prueba, scripts de package.json, ejemplos de variables, .gitignore y documentación. Se regeneraron los artefactos de build y pruebas. No se editaron estilos, componentes QR, las cuatro migraciones existentes ni el transporte simulado de WhatsApp.

## Aplicación y despliegue: solo después de autorización

1. Confirmar el proyecto Supabase y si 005 ya está aplicada. Si existe, auditar con `supabase/checks/current_profile_audit.sql` y **no reaplicarla**. Si falta, revisar preflight y aplicar **solo la nueva migración 005**, con autorización específica, mediante el procedimiento habitual; nunca volver a ejecutar las cuatro existentes ni usar reset. Ejemplo preparado únicamente para ese último caso:

```powershell
psql "$env:CAI_AUTHORIZED_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/checks/current_profile_preflight.sql
# Revisar resultados antes del siguiente comando de escritura.
psql "$env:CAI_AUTHORIZED_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261023000500_current_profile_rpc.sql
```

2. Verificar la cuenta Cloudflare, identificar el Worker existente y guardar/revisar su versión actual. Si hay endpoints o bindings desplegados que no están en este repositorio, integrarlos antes de desplegar: estos archivos locales no prueban qué código tiene hoy el Worker. No continuar si la cuenta no corresponde o el Worker no aparece. No se fija un account_id inventado.

```powershell
npx wrangler@4 whoami
npx wrangler@4 deployments list --config worker/api/wrangler.jsonc --name cai-market-api
```

3. Las variables Supabase ya están configuradas en el Worker según el estado comunicado. No necesitan sobrescribirse. Desplegar el Worker existente solo tras autorización, sin cambiar su nombre ni crear entornos/Workers nuevos. Este comando **modifica Cloudflare** y no se ejecutó:

```powershell
npx wrangler@4 deploy --config worker/api/wrangler.jsonc
```

`keep_vars: true` conserva las variables remotas no declaradas; `ALLOWED_ORIGIN` se administra en la configuración. MEDIA se declara explícitamente en `r2_buckets`: keep_vars no conserva por sí solo los bindings de recursos. No se añaden cron, colas, transportes de WhatsApp ni claves de base. Si existe una configuración remota adicional de rutas/bindings, revisarla y preservarla antes del despliegue. El desarrollo local usa R2 local y no lee/escribe el bucket remoto.

4. Configurar las tres variables `VITE_*` también en Cloudflare Pages y reconstruir el frontend. Los comandos exactos para subir `dist` al proyecto existente, seleccionando su rama de producción confirmada, están en la auditoría enlazada. Verificar `/health`, login real del administrador, `/api/me` y errores 401/403. No poner tokens en URLs, historial de comandos, capturas o documentación. No se ha realizado ese ensayo remoto con la cuenta del administrador.

## Fuentes oficiales

- [Supabase: funciones, SECURITY DEFINER, search_path y EXECUTE](https://supabase.com/docs/guides/database/functions).
- [Supabase: Auth y auth.uid()](https://supabase.com/docs/guides/database/postgres/row-level-security).
- [Cloudflare: configuración de Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/).
- [Cloudflare: bindings y secretos](https://developers.cloudflare.com/workers/configuration/secrets/).
