# Corrección de la migración 005 en Supabase alojado

La versión original falló según el error remoto comunicado: `ADMINISTRATOR_CANNOT_GRANT_AUTH_USAGE`. Esta revisión modifica únicamente la migración 005 pendiente; no modifica las migraciones 001–004 aplicadas. No se ejecutó SQL remoto ni se desplegó nada. La ausencia de registro y de cambios parciales en producción queda pendiente de ejecutar el preflight: el mensaje de error por sí solo no certifica el historial.

## Causa y permisos reales

Para llamar directamente a `auth.uid()` se necesitan **USAGE sobre el esquema auth y EXECUTE sobre la función**. EXECUTE no implica USAGE. No se necesita SELECT sobre `auth.users`, propiedad de auth, CREATE, BYPASSRLS ni superusuario.

Supabase documenta exactamente este problema: el rol alojado `postgres` no es superusuario y tiene USAGE sin GRANT OPTION sobre auth. El propietario del esquema es `supabase_admin`; las funciones/tablas pertenecen a `supabase_auth_admin`. Un GRANT puede emitir `WARNING: no privileges were granted` sin fallar. La comprobación posterior detecta correctamente que el privilegio no cambió. El catálogo concreto del proyecto debe confirmarse con el preflight.

Fuente primaria: [Supabase: permisos de roles personalizados sobre auth](https://supabase.com/kb/troubleshooting/permission-errors-when-granting-custom-roles-access-to-the-auth-schema). Reglas generales: [PostgreSQL GRANT](https://www.postgresql.org/docs/current/sql-grant.html).

## Solución y límite de seguridad

Se aplica el patrón de helper SECURITY DEFINER privado recomendado por Supabase. `pos.current_profile_auth_uid()` pertenece al administrador que ejecuta la migración (normalmente postgres), conserva su acceso existente a auth y solo ejecuta `SELECT auth.uid()`. Su EXECUTE se revoca a PUBLIC, anon, authenticated, service_role, pos_app y pos_scheduler, y se concede únicamente a pos_owner; el propietario y administradores mantienen sus privilegios inherentes.

**No se modifica ningún permiso de auth.** No se concede membresía en authenticated ni en roles administrados a pos_owner. Un USAGE directo permitiría resolver otros objetos de auth que tengan EXECUTE/otros permisos preexistentes; evitarlo limita ese alcance. El riesgo del puente es ejecutar su cuerpo con permisos del administrador: se limita a una sola expresión, sin parámetros ni SQL dinámico, con `search_path = pg_catalog, pg_temp`, referencia cualificada y sin CREATE de pos_owner sobre pos. No debe ampliarse para leer usuarios o ejecutar consultas arbitrarias.

La RPC pública continúa perteneciendo a pos_owner, con cuatro campos de salida, cero argumentos, STABLE, SECURITY DEFINER y búsqueda fija. Antes de leer exige sesión authenticator, rol authenticated, sujeto igual al auth.uid() devuelto por el puente y expiración vigente. Solo devuelve `p.id = v_uid AND p.active`. El helper no valida firmas: Auth/PostgREST hacen esa validación, y el Worker mantiene la verificación adicional de identidad. Una RPC expuesta que permita cambiar claims o ejecutar SQL arbitrario comprometería este límite; revisar las funciones públicas con la auditoría.

Dependencias revisadas: perfiles y roles de 001; propietarios, RLS y permisos de 004; auth.uid() administrado; public/pos para resolución y creación; gateway authenticator; Worker `/api/me`. `pos.require_staff` ya lee los claims del gateway y no depende de auth.uid(); no requiere modificación. Las tablas financieras conservan pos_owner. La única excepción nueva entre las funciones de pos es el puente propiedad del migrador.

El SQL completo corregido es [20261023000500_current_profile_rpc.sql](../../supabase/migrations/20261023000500_current_profile_rpc.sql). No usa CREATE OR REPLACE: aborta si ya hay cualquier sobrecarga de la RPC/helper o si 005 está registrada. CREATE en public se presta temporalmente a pos_owner para transferir solo la RPC y se revoca en la misma transacción. El migrador necesita CREATE en pos, creación/concesión en public y capacidad de SET ROLE pos_owner, además de su acceso existente a auth.uid(); no necesita superusuario.

## Estado fallido y comprobación antes de aplicar

La migración original contiene BEGIN/COMMIT y falla antes de crear la RPC o conceder CREATE en public. Si se ejecutó el archivo completo en una transacción, el fallo impide el COMMIT y no debe dejar cambios. Si la conexión sigue en transacción abortada, ejecutar ROLLBACK en esa misma conexión. Una conexión nueva no puede cancelar una transacción de otra sesión. No asumir atomicidad si se ejecutaron selecciones del editor por separado.

El [preflight](../../supabase/checks/current_profile_preflight.sql), en transacción READ ONLY:

- Aborta si `supabase_migrations.schema_migrations` registra `20261023000500`.
- Aborta si existe cualquier sobrecarga de cai_current_profile/current_profile_auth_uid o CREATE de pos_owner en public.
- Informa ACL y propietarios de auth/public/pos, flags, permisos y propietarios/RLS de tablas para comparar con 004 y una línea base anterior.
- Si falta la tabla de historial, informa que no hay historial automático. SQL Editor y psql no registran migraciones automáticamente; ausencia de fila no demuestra ausencia de objetos.

Un historial presente o un objeto inesperado exige detenerse e investigar, sin borrar registros, marcar reverted ni eliminar funciones automáticamente. Si 005 sí se aplicó correctamente, no utilizar esta edición: preparar una migración nueva. Sin una línea base no se puede demostrar ausencia de cualquier modificación histórica; sí verificar los efectos concretos de esta migración y el estado actual. Verificar además en Dashboard → Data API que `pos` NO esté en los esquemas expuestos; el SQL no certifica esa configuración externa.

## Comandos preparados para el operador

No se ejecutaron los siguientes comandos. Usar conexión de base de datos del Dashboard con el administrador autorizado, nunca claves frontend ni service_role. Ejemplo PowerShell con conexión directa y contraseña solicitada por psql (no escribirla en el comando):

```powershell
Set-Location E:\Project_CAI_Market
$env:PGHOST = 'db.<PROJECT_REF>.supabase.co'
$env:PGPORT = '5432'
$env:PGDATABASE = 'postgres'
$env:PGUSER = 'postgres'
$env:PGSSLMODE = 'require'

# 1. Solo lectura; revisar proyecto, historial, ACL, RLS y ausencia de objetos.
psql -X -W -v ON_ERROR_STOP=1 -f supabase/checks/current_profile_preflight.sql
if ($LASTEXITCODE -ne 0) { throw 'Preflight fallido: no aplicar 005' }

# 2. Solo si el preflight y la revisión manual confirman 005 pendiente y sin restos.
psql -X -W -v ON_ERROR_STOP=1 -f supabase/migrations/20261023000500_current_profile_rpc.sql
if ($LASTEXITCODE -ne 0) { throw '005 falló: revisar antes de continuar' }

# 3. Auditoría posterior; revisar también los resultados, no solo el código de salida.
psql -X -W -v ON_ERROR_STOP=1 -f supabase/checks/current_profile_audit.sql
if ($LASTEXITCODE -ne 0) { throw 'Auditoría fallida' }
```

Sustituir PROJECT_REF y los parámetros por los de la conexión real. Si se usa pooler por falta de IPv6, copiar host/puerto/usuario del Dashboard y preferir modo sesión para esta operación. Ejecutar los pasos por separado para revisar los resultados entre ellos. No usar db reset, no ejecutar 001–004 de nuevo.

Si el proyecto ya usa historial CLI, tras aplicar por psql y validar la auditoría, registrar **solo esa versión** con el CLI previamente vinculado al proyecto correcto:

```powershell
supabase migration list --linked
# Solo después de comprobar la aplicación real y la auditoría, pues repair solo cambia historial:
supabase migration repair 20261023000500 --status applied --linked
supabase migration list --linked
```

La columna remota debe mostrar 005 una sola vez después de registrarla. No marcar applied antes de ejecutar SQL. Si se gestiona mediante SQL Editor sin CLI, conservar el resultado y el procedimiento de registro habitual del proyecto; no inventar filas manuales. Referencia: [Supabase CLI, historial y repair](https://supabase.com/docs/reference/cli/supabase-migration-repair).

## Pruebas locales

```powershell
npm run check:credit
npm run test:credit
```

PGlite simula auth.uid() y el contexto de PostgREST. El migrador de pruebas es NOSUPERUSER con USAGE de auth **sin** GRANT OPTION. Se reproduce el fallo original, se comprueba reversión ante error temprano/tardío, rechazo si está registrada o existe la RPC, acceso solo al perfil propio, ausencia/inactividad, claims inválidos, discrepancia legacy/JWT, expiración, contexto SQL fabricado, denegación de acceso directo al helper/tablas y conservación de propietarios/ACL/RLS financieros. Las pruebas no certifican JWT criptográfico, ACL remotas ni configuración Data API: requieren la revisión posterior en el proyecto real.

Resultado local del 23/10/2026: `npm run check:credit` correcto; `npm run test:credit`: **63/63 pruebas correctas**, incluidas 11 de perfil. Preflight y auditoría SQL también ejecutados correctamente contra el fixture local. Sin cambios en las migraciones 001–004.
