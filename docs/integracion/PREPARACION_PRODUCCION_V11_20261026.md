# CAI Market V1.1: preparación de producción

Fecha: 26 de octubre de 2026, America/Bogota.

**Dictamen:** respaldo PostgreSQL recuperable y ensayo de 009 aprobados. La
publicación coordinada queda preparada, pero requiere autorización y una sesión
real de prueba autorizada antes de comenzar la ventana. No se ha aplicado 009 en
producción ni se han desplegado Worker/Pages, realizado commits o fusionado main.

Infraestructura exclusiva: Supabase `sauoekefntzxhqxycdgo`, Worker
`cai-market-api`, Pages `cai-market`, dominio `https://project-market.pages.dev`,
repositorio `brysof22-ux/Project_Market`. No se creó otro proyecto ni una Preview.
Los entornos aislados son contenedores PostgreSQL locales, sin red ni puertos.

## Estado real comprobado

| Elemento | Resultado |
| --- | --- |
| Historial Supabase | Exactamente 001–008 |
| 009 | Ausente; preflight autenticado sin restos de objetos, columnas, políticas, triggers o funciones |
| Datos de tienda | 0 productos, 0 clientes, 0 ventas, 0 cargos de crédito, 0 abonos y 0 pagos |
| Caja | Ninguna abierta |
| Usuarios | 1 usuario Auth, 1 perfil administrador activo; 0 cajeros y 0 supervisores |
| Tablas `pos` | 29; propietarios/RLS/privilegios compatibles con el ensayo |
| Data API | Esquemas `public,graphql_public`; `pos` no expuesto |
| Transporte PostgreSQL | Conexión autenticada TLS 1.3, CA fijada, nombre y cadena verificados (`verify-full`) |
| GitHub main | `6ee1211bac5a9b6958994ea6cb2b4a7b3650426b`, idéntico al punto publicado |
| Worker publicado | `84dea860-d785-4387-994b-9bac21126178`, 100 % |
| Pages publicado | `6885df5d-0e86-4c00-8a4b-bd5fa1d6ce77`, production/success, commit anterior |

Se utilizaron lecturas por la API oficial de solo lectura y PostgreSQL
autenticado. `v11_production_preflight.sql` terminó con
`V11_STRUCTURE_PREFLIGHT_PASS`. La comparación final de todas las columnas de las
69 tablas contra el respaldo devolvió `tables_unchanged=true`, sin diferencias.
Esto confirma la vigencia observada; no garantiza cubrir escrituras futuras.

La única modificación remota autorizada durante esta preparación fue renovar el
acceso temporal oficial `cli_login_postgres` para respaldo y lecturas. No se
cambiaron permisos de aplicación, propietarios, esquemas o datos comerciales.
La sesión OAuth de Wrangler se renovó localmente para las lecturas de Cloudflare.

## Respaldo y ensayo

Respaldo privado:

```text
E:\CAI_Market_Backups\20261026T120305Z_sauoekefntzxhqxycdgo_v11_a7bc3671
```

Captura consistente: **07:04:15 Colombia** (`12:04:15Z`). Exportación terminada a
las 07:05:15. Se exportaron esquema, datos, roles sin contraseñas globales,
secuencias, Auth e historial; diez archivos originales con hashes verificados.
El archivo custom `database.dump` mide 588.045 bytes. Los archivos tienen ACL
Windows para el usuario actual y SYSTEM y no se incorporan a Git.

La restauración conserva las 69 tablas y 269 filas y coincide en roles,
membresías, ACL efectivas, políticas, funciones, restricciones, índices, triggers
y siete secuencias. Las adaptaciones documentadas se limitaron al bootstrap local,
creadores de extensiones y concesiones iniciales administradas de GraphQL ya
observadas en origen. No se modificó el respaldo original.

Recuperación conservada: `cai-v11-restore-4152fcdd`, detenida. Ensayo final en otra
copia: `cai-v11-upgrade-a1ed07bf`, también detenida. Evidencia privada final:

```text
E:\CAI_Market_Rehearsals\20261026T122636Z_v11_a1ed07bf
```

La migración 009 corregida pasó sin advertencias. Su registro mediante Supabase
CLI 2.122.0 produjo **58 statements** y el historial pasó de ocho a nueve versiones.
Todas las filas y columnas originales se preservaron antes de insertar fixtures.

En datos ficticios se comprobaron: crédito por cajero sin cupo previo, abono inicial
25 más abono posterior 30 sin duplicación, asignación por deuda e idempotencia,
rechazos de administración/Supervisor/caja ajena, devolución con reintegro 55 y
reducción de deuda 45, y reinicio con autenticación reciente. El reinicio conservó
ocho unidades y deuda 100 en el archivo y abrió un período con stock cero. Las
auditorías posteriores comprobaron todos los períodos.

La barrera de mantenimiento se probó antes y después del DDL. Retira únicamente
INSERT/UPDATE/DELETE/TRUNCATE de `pos_owner` en las 29 tablas anteriores y SELECT
de idempotencia. Los escritores ficticios quedaron bloqueados. Las 29 ACL se
restauraron literalmente al valor inicial. Cada captura terminó su transacción
antes del DDL y se verificaron actividad y bloqueos; no se usó un advisory lock
como garantía de exclusión. En producción la barrera debe mantenerse hasta que
los tres componentes compatibles estén publicados y comprobados.

El respaldo PostgreSQL no contiene objetos R2/Storage, configuración externa de
Auth/Cloudflare, claves externas de cifrado ni contraseñas globales de roles. La
restauración lógica no sustituye una recuperación completa de esos servicios.

## Correcciones locales surgidas de la preparación

1. **009:** la revocación masiva incluía el puente de autenticación de 005,
   administrado por `postgres`. Se sustituyó por revocaciones enumeradas que
   excluyen exactamente ese puente. Un guard rechaza ACL adicionales en él y
   una prueba compara propietario, definición y ACL antes/después. Se conserva
   su único EXECUTE operativo para `pos_owner`; no se concedió nada en `auth`.
   El primer clon con advertencias se conservó como intento fallido, sin registrar
   009, y el ensayo se repitió desde una copia limpia.
2. **Desarrollo:** `dev:api` apuntaba al archivo de producción pese a usar `--local`.
   Ahora usa `wrangler.local.jsonc` y `LOCAL_ONLY=true`, que rechaza destinos reales
   aunque una variable local los sobrescriba. La configuración de producción no
   contiene ese indicador y conserva sus destinos y bindings.
3. **Sonda TLS:** `pg_stat_ssl` en el servidor describe el tramo interno del pooler,
   no el socket del cliente. La evidencia se toma del socket TLS autenticado con
   CA y hostname verificados; no se deshabilitó ni relajó TLS.

SQL final ensayado:

```text
20261025000900_v11_periods_permissions.sql
SHA-256 6e7c588f6cd9bdd91f85b33cb9a90610e27d49aecfc2c544f92280b9f336d810
```

El registro preparado desde el CLI oficial tiene SHA-256
`502a2d75df132db8e8f95011e4175eb68db31319915410efac7fd32e2874a53b`.
No debe utilizarse la versión anterior de 009 con hash `0953e43c…`.
Las migraciones aplicadas 001–008 permanecen intactas.

## Pruebas finales

| Comando/comprobación | Resultado |
| --- | --- |
| `npm run test:api` | 178 aprobadas, incluidas denegaciones HTTP directas e aislamiento local |
| `npm run test:credit` | 128 aprobadas, incluidos preflight/auditoría y conservación del puente 005 |
| `npx playwright test --workers=1` | 47 aprobadas; repetidas con el SQL corregido |
| `check:api`, `check:credit`, `tsc -b`, lint | Aprobados |
| Compilación y escaneo del bundle | Aprobados; permanece aviso de chunk principal de unos 512 kB |
| CSP/cabeceras del artefacto local | 7 comprobaciones aprobadas |
| Workerd local | 14 comprobaciones aprobadas, sin solicitudes remotas |
| Concurrencia PostgreSQL 17.11 | 9 escenarios aprobados con conexiones independientes, hash SQL final |
| Respaldo restaurado + 009 | Conservación de datos, auditoría y mantenimiento aprobados |
| Infraestructura publicada actual | Health, JWT ficticio, CORS, rutas sin sesión y bundle públicos: aprobados en solo lectura |

Las fronteras Auth de las pruebas locales se simulan. No se presenta esa evidencia
como un inicio de sesión real. Las pruebas HTTP de Cajero rechazan acciones antes
de invocar RPC; las pruebas PostgreSQL comprueban además la denegación sin Worker.

## R2 y autenticación

La configuración real confirma `MEDIA → cai-market-media`, bucket privado,
`r2.dev` deshabilitado y sin dominios personalizados. No hay regla de borrado de
objetos. El binding permite las operaciones get/put requeridas por su contrato
oficial; no se necesitan credenciales R2 en el frontend.

No se ejecutó una subida/descarga remota de objeto: requiere una escritura que
esta fase no autoriza. Tampoco se enumeraron fotografías reales. El bucket no
necesita CORS público porque el navegador consume el Worker autenticado; su CORS
ausente no es un motivo para abrirlo. La comprobación práctica deberá utilizar un
objeto ficticio autorizado, nunca una fotografía comercial. No se añade un
endpoint diagnóstico ni un token S3 persistente para eludir esta limitación.

No se ha identificado una **cuenta de prueba autorizada**. El único administrador
existente no se asume disponible para pruebas. Procedimiento seguro:

1. El propietario autoriza expresamente una cuenta existente para lecturas de
   prueba o la creación de una cuenta dedicada. No se cambia el rol del usuario
   real para simular un cajero.
2. Si se necesita crearla, usar Supabase Auth en el proyecto original, contraseña
   aleatoria guardada en un gestor y confirmación de correo según la política
   actual. Crear únicamente el perfil controlado necesario con el rol acordado;
   hacerlo requiere autorización adicional. No habilitar signup público ni
   introducir service_role en el frontend.
3. La persona introduce la contraseña en una entrada local protegida o inicia
   sesión personalmente. La contraseña/JWT no se envía al chat, terminal visible,
   archivos de informe o capturas. Mantener la sesión de prueba en memoria.
4. Comprobar Supabase Auth → `/api/me`: HTTP 200, UUID del mismo usuario, cuatro
   campos permitidos, perfil activo y rol esperado. Probar rechazo sin JWT y con
   JWT ficticio. Con sesión de Cajero se pueden verificar rechazos de consultas
   administrativas sin invocar ventas, pagos, reinicios o cambios de productos.
5. Si se creó una cuenta o cambió el estado desde el respaldo, repetir captura y
   verificación necesarias antes de DDL; no reutilizar una comparación antigua
   afirmando que es el estado actual. No borrar usuarios automáticamente al final.

## Procedimiento exacto de publicación, todavía no autorizado

Preparados SQL fijos y manifiesto privado:

```text
E:\CAI_Market_Preflight\20261026T115815Z_v11
```

No ejecutar sus archivos de escritura hasta obtener autorización explícita. Toda
sesión PostgreSQL debe usar el pooler original, usuario temporal del proyecto,
`sslmode=verify-full`, CA fijada y `SET ROLE postgres` explícito; nunca credenciales
en argumentos o URL. Mantener una conexión de recuperación viva durante la ventana.

1. **Precondiciones:** verificar cuenta autorizada, respaldo vigente, hash SQL
   anterior, main remoto aún en `6ee1211…`, artefactos aprobados, rol/ACL actuales,
   ausencia de operaciones activas y ventana coordinada con los operadores. Si
   algo cambió, detenerse. No considerar un aviso verbal garantía de exclusión.
2. **Mantenimiento:** capturar de nuevo las ACL y compararlas con el estado ensayado;
   ejecutar `maintenance_on.prepared.sql`. Confirmar con
   `maintenance_closed_readonly.prepared.sql`. Cerrar su transacción y ejecutar
   `quiet_readonly.prepared.sql`. Debe haber cero escritores/transacciones o
   bloqueos incompatibles. No matar sesiones ni esperar bloqueos indefinidamente.
3. **Supabase 009:** aplicar una sola vez el archivo completo con hash `6e7c…d810`,
   `ON_ERROR_STOP=1`, `lock_timeout=5s` y `statement_timeout=120s`. No envolver su
   BEGIN/COMMIT en otra transacción. Cualquier warning, error o COMMIT ambiguo
   detiene el procedimiento sin registrar ni reintentar a ciegas.
4. **Validar antes de registrar:** ejecutar
   `validate_009_before_history.prepared.sql` y comparar las columnas originales
   con `original_data_readonly.prepared.sql`. Comprobar propietarios, permisos,
   RLS, puente 005, saldos, abonos, existencias, constraints, índices y triggers.
   El historial todavía debe contener ocho versiones.
5. **Registrar:** ejecutar `register_20261025000900.prepared.sql`, extraído del
   CLI ensayado, sin modificar sus 58 statements. No ejecuta las sentencias
   almacenadas como texto. Comprobar versión única, nombre y array exactos.
   Ejecutar `supabase/checks/v11_postmigration_integrity.sql`. Mantener el bloqueo.
6. **Worker V1.1:** publicar sólo `cai-market-api`, conservando todos los bindings,
   secretos y variables. Guardar su version ID. Verificar health, CORS, JWT inválido,
   rutas protegidas y `/api/me`; no realizar operaciones comerciales. Mientras
   la barrera esté activa, las RPC de negocio deben seguir bloqueadas.
7. **Pages V1.1:** crear el commit de los archivos manifestados, integrar main
   mediante fast-forward y subir **sólo main**. No subir feature ni crear Preview.
   Esperar deployment production/success, verificar commit, dominio, CSP,
   cabeceras, rutas, módulos y comunicación con el Worker compatible.
8. **Abrir la operación:** sólo tras comprobación de código, identidad e integridad,
   ejecutar `maintenance_restore.prepared.sql`. Verificar igualdad literal de las
   29 ACL, SELECT de idempotencia, CREATE retirado y auditoría de todos los períodos.
   Comprobar bootstrap/lecturas con sesión autorizada. No efectuar ventas de prueba.

Comando de preparación local repetible, sin publicación:

```powershell
node scripts/v11/prepare-worker.mjs
node scripts/v11/prepare-release-manifest.mjs
```

Comando Worker reservado para la autorización posterior:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = 'f2f2dcbac86bc1a805d13cc387c8a568'
$env:CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false'
$env:CLOUDFLARE_SEND_METRICS = 'false'
node .cache/npm/_npx/c943b712072b77c4/node_modules/wrangler/bin/wrangler.js deploy --config worker/api/wrangler.jsonc --keep-vars --message 'CAI Market V1.1'
```

Comandos Git reservados para la autorización, después de verificar nuevamente
manifiesto, árbol e índice. Cualquier cambio inesperado obliga a revisar de nuevo:

```powershell
git fetch origin main
git rev-parse origin/main
git add --pathspec-from-file=.cache/v11-prepared-release/paths.nul --pathspec-file-nul
git diff --cached --check
git commit -m "release: CAI Market V1.1"
git switch main
git merge --ff-only feature/cai-market-v1.1
git push origin main
```

No forzar un push ni sobrescribir cambios ajenos. El push de main inicia el Pages
automático actual. La rama feature conserva su guard de build para evitar una
Preview accidental. Main local/remoto no se han movido durante esta preparación.

## Recuperación y criterios de parada

- **Antes de 009:** rollback de la transacción fallida y recuperación exacta de ACL
  mediante el procedimiento ensayado. Confirmar integridad antes de abrir.
- **Después del COMMIT de 009:** ROLLBACK no deshace el esquema. Mantener la barrera
  ante errores. No retirar RLS, desactivar triggers, reparar datos o restaurar un
  dump sobre producción automáticamente. Corregir con una solución compatible
  con V1.1 ensayada; una restauración del respaldo requiere otra autorización y
  evaluación de cambios posteriores.
- **Worker:** la versión `84dea860-d785-4387-994b-9bac21126178` está disponible para
  reversión técnica mediante `wrangler rollback`. No revierte PostgreSQL ni R2.
- **Pages:** deployment anterior `6885df5d-0e86-4c00-8a4b-bd5fa1d6ce77`, disponible
  para rollback. Verificar deployment canónico y dominio después. Si main ya se
  subió, documentar su nuevo commit; no hacer force-push o revert innecesario.
- **Límite crítico:** Worker/Pages V1 no envían `expected_period`/`expected_total`.
  Volver sólo a esos componentes tras 009 **no recupera las escrituras**. Mantener
  mantenimiento hasta disponer de una versión V1.1 compatible o recuperación
  integral autorizada. No presentar ese rollback técnico como retorno operativo.
- **R2:** no se cambian acceso público ni reglas. No eliminar objetos nuevos o
  históricos para revertir código; conservarlos y reconciliar referencias.
- **Parada:** warning SQL, permisos inesperados, diferencia de filas/saldos,
  checksum cambiado, error de historial, transacción/bloqueo incompatible,
  autenticación real fallida, deployment incorrecto o fallo de recuperación de ACL.
  No habilitar operaciones si no puede demostrarse la integridad y la apertura
  exacta de permisos.

## Impacto en usuarios existentes

El único perfil actual sigue siendo Administrador y sus datos no se transforman.
No hay Supervisor o Cajero existente que reclasificar en el estado observado; el
preflight lo comprobará otra vez antes de actuar. Los roles Supervisor futuros o
incorporados después de esta captura requerirán decisión explícita del administrador.

El cambio de contrato bloquea pestañas V1 antiguas. Se necesita la ventana y una
recarga de la aplicación tras abrirla. No se admite escritura en un período nuevo
desde un carrito o formulario obsoleto. Las deudas archivadas mantienen su saldo
histórico; archivarlas no las perdona y no se cobran implícitamente en otro período.

## Informes de soporte

- [Restauración y ensayo completo](V11_RESPALDO_ENSAYO_20261026.md).
- [Lecturas reales de Cloudflare y R2](V11_CLOUDFLARE_PREPARACION_20261026.md).
- [Pruebas locales](V11_PRUEBAS_PREPRODUCCION_20261026.md).
- Preflight y auditoría de solo lectura: `supabase/checks/v11_*`.
- Evidencias originales con Auth/dumps y logs privados permanecen fuera de Git.

La siguiente actuación sobre producción requiere autorización explícita. No se
considera validado el inicio de sesión real ni el PUT/GET remoto de R2 mientras
esas comprobaciones no se hayan ejecutado con el alcance permitido.
