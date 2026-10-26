# CAI Market V1.1: diseño, implementación y validación local

Fecha de validación: 26 de octubre de 2026, America/Bogota.

Rama de desarrollo: `feature/cai-market-v1.1`, creada desde la versión publicada
`6ee1211bac5a9b6958994ea6cb2b4a7b3650426b`.

Este trabajo no autoriza publicar, ejecutar SQL remoto ni utilizar operaciones
comerciales o almacenamiento de producción como banco de pruebas. Las migraciones
001–008 son historia aplicada: no se reescriben.

## Decisiones confirmadas

- Administrador: acceso completo.
- Cajero: Punto de venta y Deudas. Puede vender al contado o a crédito y registrar
  abonos. Puede abrir y cerrar exclusivamente su propia caja desde el POS; no
  obtiene acceso a Contabilidad, inventario administrativo, gastos o reportes.
- No se requiere una autorización administrativa previa para cada venta a crédito
  del cajero. La autorización y el importe financiado se registran en el servidor.
- Los perfiles Supervisor existentes se conservan. El administrador debe elegir
  explícitamente Administrador o Cajero; mientras tanto no acceden a los módulos.
- Una persona nueva a crédito recibe un UUID. Nunca se fusionan personas por
  nombre ni por teléfono. Elegir una ficha existente exige seleccionar su UUID.
- La fecha de vencimiento omitida significa sin vencimiento; las fechas históricas
  se conservan. Un teléfono de contacto no constituye consentimiento de mensajería.

## Dependencias de V1 y cambios

V1 usa React → Worker → RPC públicas en PostgreSQL, con tablas privadas en `pos`.
Los pagos, salidas de inventario, cargos de crédito y caja se registran dentro de
transacciones con idempotencia e invariantes diferidas. Esas protecciones siguen
siendo necesarias en V1.1.

V1 permitía al cajero consultar inventario, algunas operaciones genéricas sobre
clientes y reportes limitados. Ocultar enlaces resulta insuficiente: V1.1 aplica
una lista explícita de acciones en interfaz, Worker y RPC. Las funciones privadas
anteriores no deben constituir otra vía EXECUTE para los roles de aplicación.

El formulario simplificado conserva nombre, precios, existencias y stock mínimo.
Los SKU nuevos se generan en PostgreSQL; editar un producto no borra su categoría,
código de barras o SKU histórico. Cambiar existencias genera un movimiento y
comprueba el stock esperado bajo bloqueo para evitar sobrescribir una venta.

En el POS el comprador normal es opcional y se presenta como Consumidor final.
Una venta financiada admite alta de persona dentro de la misma operación. El
abono inicial forma parte de los pagos de la venta: no genera además un recibo de
cartera. Los abonos posteriores se asignan a una deuda identificada por UUID y no
pueden superar su saldo. La vista Deudas incluye compra, productos, pagos, saldo
y estados pendiente, vencida y pagada.

El servidor calcula los precios y comprueba el total que el vendedor revisó. Un
precio cambiado mientras el carrito está abierto produce `PRICE_CHANGED` y revierte
la operación completa, incluida el alta inline de la persona. La financiación no
puede aumentar silenciosamente por un cambio de precio.

El crédito utiliza una autorización inmutable de alcance `sale`, vinculada a la
venta y al principal exacto financiado. Su importe se calcula en el servidor. El
cajero no proporciona un cupo ni puede ejecutar el comando administrativo de
autorización general. Se conservan los controles diferidos sobre pagos, deuda,
asignaciones y caja; una devolución declara explícitamente reintegro y reducción
de deuda, sin presentar esa compensación como un abono recibido.

## Fotografías y R2

El repositorio tiene el binding `MEDIA` al bucket existente. Su presencia local no
demuestra los permisos efectivos del bucket remoto. No se cambia su configuración.

El frontend transmite archivos a un endpoint autenticado del Worker. Sólo un
administrador puede adjuntarlos. Los objetos tienen identificadores generados por
el servidor; las lecturas se autorizan con el perfil y la referencia de producto
almacenada en PostgreSQL. No se publican claves R2, URLs con JWT ni el bucket.
Las imágenes se muestran mediante blobs obtenidos con Authorization y se liberan
al desmontar componentes/cerrar sesión. La CSP permite estos blobs.

El upload tiene límites de bytes reales, tipo y dimensiones, rechaza SVG/HTML y
otros formatos no permitidos, y usa respuestas sin caché y `nosniff`. La operación
R2 y el commit PostgreSQL no son una transacción distribuida. Si una respuesta de
vinculación se pierde después de un posible COMMIT, el Worker reconsulta exactamente
esa referencia. Ante un resultado incierto conserva el objeto privado; no elimina
una imagen que podría estar vinculada. Una futura limpieza debe comprobar
referencias y operar exclusivamente sobre objetos sin vínculo. Los errores se
muestran sin cuerpos del proveedor, claves ni trazas.

El navegador decodifica y recodifica las fotografías antes de enviarlas. El Worker
valida estructura del contenedor, dimensiones, tamaño y tipo, y retira metadatos.
No incorpora un decodificador completo de píxeles en el servidor: una compresión
corrupta que pase esos controles puede producir una foto ilegible. No se admiten
formatos activos, respuestas HTML ni interpretación por sniffing.

Las pruebas usan un binding simulado o R2 local. No se utilizará `remote: true` ni
el bucket real durante desarrollo. La verificación remota de permisos de R2 queda
como condición de una publicación futura autorizada.

## Diseño del reinicio operativo, presentado antes de implementarlo

El reinicio archiva un período y activa otro. No borra ventas, deudas, abonos,
gastos o auditoría. Tampoco reinicia secuencias ni elimina productos, fotografías,
precios, usuarios o perfiles. Las existencias iniciales del nuevo período son cero;
las existencias históricas se conservan en el período anterior.

Cada registro operativo pertenece a un período. Las cuentas de crédito y los
balances de inventario pueden existir nuevamente para la misma persona/producto
en períodos diferentes. El período heredado se asigna mediante un valor constante
al agregar columnas, sin UPDATE de libros inmutables ni desactivar sus triggers.
Las políticas RLS se fuerzan también al propietario operativo para que las
consultas existentes no incluyan accidentalmente información archivada.

La función de reinicio exige perfil administrador, autenticación reciente,
confirmación literal, motivo, período esperado y clave de idempotencia. Un token
recién renovado no prueba autenticación reciente: se comprueba `amr` y la fecha de
un método de autenticación válido; `iat` no basta. La comprobación se repite en SQL
para que omitir el Worker no permita eludirla.

Los comandos adquieren una compuerta transaccional de fila antes de operar. Los
escritores usan un bloqueo compartido; el reinicio exige uno exclusivo con NOWAIT.
Así un reinicio rechaza operaciones activas y los escritores rechazan un reinicio
en curso. La compuerta abarca los comandos heredados y el scheduler; un advisory
lock aislado no garantiza la exclusión. Triggers defensivos comprueban referencias
y pertenencia al período. Los bloqueos desaparecen al commit o rollback.

Si hay una caja abierta, el reinicio falla sin modificar nada. Los comandos deben
enviar el período obtenido al abrir el formulario. Si otra sesión reinició la
operación, el servidor rechaza la solicitud antigua. No se acepta una mutación de
un cliente V1 sin período esperado, porque podría escribir en el período nuevo.

Archivar una deuda **no significa perdonarla ni declararla pagada**. El historial
permanece disponible para el administrador, fuera de la operación activa. Cobrar
o devolver una operación archivada requiere un diseño separado; no se aplican
abonos o devoluciones antiguos al nuevo período de forma implícita.

## Validación y publicación futura

La implementación requiere pruebas de permisos por solicitudes HTTP directas y
RPC, homónimos, abonos iniciales y posteriores, límites de deuda, inventario,
idempotencia, devoluciones, caja propia, fotografías y reinicio con/sin cajas.
Los ensayos de concurrencia deben usar conexiones PostgreSQL independientes:
PGlite valida SQL e invariantes, pero no demuestra concurrencia entre conexiones.

La actualización futura es coordinada: base de datos, Worker y frontend. Un
cliente V1 sin período no es compatible para escrituras tras V1.1. No se debe
publicar el Worker o ejecutar las migraciones V1.1 por separado dejando habilitado
el cliente anterior. Antes de una publicación se necesitan respaldo recuperable
reciente, ensayo sobre una copia del estado actual y autorización explícita.

La rama V1.1 bloquea el build automático de Pages. El servidor Vite de desarrollo
también rechaza las URL de Supabase y Worker de producción, aunque hayan quedado
en `.env.local` de V1. Los ensayos del navegador fijan destinos ficticios e
interceptan Auth/API. Crear la rama no la publica y
no se ha autorizado subirla, integrar main ni desplegar. No hay claves de prueba
ni bypasses de autenticación en el código de producción.

## Fuentes técnicas oficiales

- [Cloudflare R2: API de Workers](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
- [PostgreSQL: políticas RLS y FORCE ROW LEVEL SECURITY](https://www.postgresql.org/docs/17/ddl-rowsecurity.html).
- [PostgreSQL: bloqueos de fila y transacciones](https://www.postgresql.org/docs/17/explicit-locking.html).
- [Supabase: campos del JWT, incluidos amr y session_id](https://supabase.com/docs/guides/auth/jwt-fields).
- [Supabase: sesiones y renovación](https://supabase.com/docs/guides/auth/sessions).

## Migración implementada

`supabase/migrations/20261025000900_v11_periods_permissions.sql` se aplica después
de 001–008. Contiene en una transacción períodos y compuerta, pertenencia de filas,
RLS forzada, validación de referencias entre períodos, autorización por acción,
crédito por venta, abonos dirigidos, metadatos de fotografías y reinicio seguro.

SHA-256 ensayado:
`0953e43c041ef2d10877100755008ae62d2e648a65b6fe1024d0df77f0f127db`.

No se modificó ningún archivo de 001–008. Tampoco se modificaron los propietarios
financieros ni los permisos de `auth`. Los permisos CREATE temporales de
`pos_owner` se retiran al finalizar la transacción, igual que en las migraciones
anteriores. El preflight rechaza un propietario con privilegios incompatibles.
No se incluye una restauración o reversión automática sobre producción.

## Resultado ejecutado de la validación local

| Comprobación | Resultado |
| --- | --- |
| `npm run test:api` | 163 aprobadas |
| `npm run test:credit` | 125 aprobadas: 83 contratos V1 y 42 pruebas V1.1 |
| `npx playwright test --workers=1` | 47 aprobadas |
| `npm run check:api` y `npm run check:credit` | Aprobadas |
| `npx tsc -b` y `npm run lint` | Aprobadas, sin advertencias de lint |
| `npm run build` | Aprobada; advertencia de tamaño del chunk principal, aproximadamente 512 kB |
| `node scripts/check-v1-build.mjs` | Sin marcadores de demostración ni claves secretas del patrón comprobado en el bundle |
| `node scripts/verify-frontend-artifact.mjs` | 7 comprobaciones de CSP/rutas/cabeceras aprobadas; cero solicitudes remotas |
| `node scripts/verify-worker-runtime.mjs` | 14 comprobaciones en workerd aprobadas; cero solicitudes remotas |
| PostgreSQL 17.11 con conexiones independientes | 9 escenarios aprobados, hash final de 009 coincidente |

Las pruebas V1 permanecen fijadas explícitamente a 001–008 para verificar el
contrato publicado. Una fixture diferente actualiza a V1.1; las pruebas de
navegador utilizan esa base actualizada y el Worker real con límites Auth/R2
simulados. No se eliminaron ni omitieron casos para conseguir estos resultados.

La prueba de actualización compara todas las columnas originales y todas las
filas antes/después de 009: preserva la información, las fechas de vencimiento
anteriores, propietarios, políticas, permisos e invariantes financieras. Otros
casos prueban HTTP directo del cajero, RPC sin pasar por el Worker, perfil ajeno,
homónimos, crédito sin cupo previo, pago inicial sin duplicación, asignación de
abonos a la deuda seleccionada, devolución compensatoria, imágenes mediante CAS,
conteo obsoleto y precio cambiado.

El ensayo real de concurrencia comprobó:

1. Venta simultánea de la última unidad: una venta y un rechazo, stock cero.
2. Dos reintentos de una venta: una sola venta/pago/salida.
3. Abonos simultáneos superiores a la deuda: el segundo se rechaza.
4. Reintento concurrente de abono: un solo recibo.
5. Devolución simultánea: una sola devolución y una reposición.
6. Cierre duplicado: un solo arqueo.
7. Venta frente a cierre: la venta posterior al cierre se rechaza sin cambios.
8. Escritor activo frente a reinicio: el reinicio falla inmediatamente.
9. Reinicio activo frente a escritor: la escritura falla inmediatamente.

Se observaron bloqueos reales con `pg_stat_activity` y `pg_blocking_pids` y PIDs
distintos; los rechazos NOWAIT no esperan bloqueos. El ensayo también verificó
existencias cero en el período nuevo, cuatro ventas originales conservadas,
ausencia de sobreasignaciones o pagos duplicados, reintento idempotente del
reinicio, apertura posterior de caja y ausencia de transacciones abandonadas.
El clúster de ensayo quedó detenido.

Docker Desktop falló al arrancar por un socket local inaccesible. No se restableció
su configuración ni se borraron volúmenes. Para comprobar concurrencia se usaron
los [binarios oficiales de PostgreSQL distribuidos por EDB](https://www.enterprisedb.com/download-postgresql-binaries),
sin instalar un servicio Windows. El arnés crea su propio PGDATA bajo `.cache`,
escucha únicamente en loopback y acepta sólo datos ficticios. No importa el
respaldo comercial, no admite una URL PostgreSQL remota y retira variables PG
heredadas antes de iniciar procesos. El acceso local sin TLS no se reutiliza para
Supabase: no cambia el requisito `verify-full` de futuras conexiones remotas.

Para repetirlo con binarios PostgreSQL ya disponibles:

```powershell
node scripts/v11/verify-concurrency.mjs --pg-bin .cache/v11-tools/pgsql/bin
```

Ese comando crea un clúster nuevo y lo detiene al terminar. Los resultados y
registros quedan bajo `.cache/v11-concurrency-<UUID>/`; nunca debe sustituirse el
PGDATA generado por un directorio o una base existente. La evidencia del ensayo
final está resumida en `docs/integracion/evidencias/V11_VALIDACION_LOCAL.json`.

## Límites y próximos pasos antes de publicar

- La implementación y los ensayos son locales. No se ejecutó 009 en Supabase, no
  se desplegó ningún Worker/Pages y no se hicieron commits, push o fusiones.
  `main` permanece en `6ee1211bac5a9b6958994ea6cb2b4a7b3650426b`.
- Antes de publicar se necesita un respaldo recuperable vigente y un ensayo de
  009 contra una copia aislada del estado actual del Supabase original. Los
  ensayos descritos aquí usan registros ficticios; no certifican que producción
  no haya cambiado desde el respaldo anterior.
- Se deben comprobar permisos efectivos del bucket R2 y autenticación con una
  cuenta real autorizada en un entorno aislado. Las pruebas locales de Auth no
  sustituyen esa comprobación ni introducen un bypass en producción.
- Las imágenes privadas cuya vinculación tenga un resultado incierto pueden
  requerir reconciliación. No hay eliminación automática de imágenes históricas.
- Se necesita coordinar migración, Worker y frontend: pestañas V1 y comandos sin
  período/total esperado se rechazan deliberadamente. Volver únicamente al cliente
  V1 después de 009 no constituye una reversión funcional de escrituras.
- Supervisor no obtiene permisos automáticamente. El administrador debe revisar
  esos perfiles durante la preparación de la actualización.
- Archivar una deuda conserva el compromiso económico y el saldo histórico.
  Su cobro entre períodos necesita un procedimiento específico; no se transforma
  en una venta o ingreso nuevo y no se perdona automáticamente.

La implementación V1.1 está completada y validada localmente. Su publicación
permanece pendiente de las verificaciones de entorno y de autorización explícita.
