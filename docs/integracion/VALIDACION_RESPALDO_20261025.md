# Validación de restauración del respaldo de CAI Market

Ampliación posterior: [VERIFICACION_PRODUCCION_20261025.md](VERIFICACION_PRODUCCION_20261025.md) detectó dos ACL iniciales administrados de GraphQL que el dump no emitía como concesiones independientes. Se preparó y verificó un suplemento de recuperación sobre otra copia, sin tocar el respaldo ni producción. La igualdad del SQL exportado descrita aquí no acreditaba por sí sola esos privilegios iniciales; utilizar el paquete complementado y sus evidencias para una recuperación completa de los permisos observados.

Resultado: **restauración lógica PostgreSQL verificada**. No implica publicación aprobada ni prueba de recuperación de todos los servicios de Supabase.

Origen de la evidencia: captura consistente del proyecto `sauoekefntzxhqxycdgo`, 25 de octubre de 2026, aproximadamente 14:06 hora Colombia (`19:06Z`). Respaldo privado fuera de Git: `E:\CAI_Market_Backups\20261025T190552Z_sauoekefntzxhqxycdgo_dffc5be4`. Los diez archivos enumerados en su manifiesto conservan sus SHA-256. No se modificaron los archivos originales durante esta validación.

## Causa exacta

El primer intento falló en `roles.sql:124`:

```sql
GRANT anon TO authenticator WITH INHERIT FALSE GRANTED BY supabase_admin;
```

Intervienen `anon` (rol concedido), `authenticator` (receptor), `supabase_admin` (otorgante registrado) y `cai_restore_admin` (usuario inicial/restaurador del primer clúster). Este último era el superusuario inicial, OID 10; `supabase_admin` se había creado después. Tener `SUPERUSER` no basta para atribuir esta concesión a un otorgante distinto del usuario inicial sin que tenga `ADMIN OPTION` sobre el rol concedido. La [documentación de PostgreSQL 17 sobre GRANT](https://www.postgresql.org/docs/17/sql-grant.html) establece expresamente esa condición y la excepción para el superusuario inicial.

Fue una incompatibilidad de inicialización del destino, no un error TLS ni una necesidad de ampliar permisos de producción. El segundo clúster se inicializó con `supabase_admin` como usuario inicial, OID 10. Las 26 concesiones originales se reconstruyeron sin cambiar otorgante ni opciones `ADMIN`, `INHERIT` o `SET`.

## Entorno y adaptaciones locales

Se utilizó PostgreSQL Supabase `17.11.0.003`, PostgreSQL `17.11`, igual al origen, con sus extensiones compatibles, incluido `supabase_vault 0.3.1`. Imagen fijada:

```text
public.ecr.aws/supabase/postgres@sha256:7374d196da7e301512cc5329e18040e0f7bb856287b323777cdadecccbc6c7e4
```

Contenedor: `cai-v1-restore-bootstrap-dffc5be4`. Volumen: `cai-v1-restore-bootstrap-dffc5be4-data`. Sin red (`--network none`), sin puertos publicados y sin escucha TCP; acceso exclusivo por socket local mediante Docker. El respaldo se montó en modo de solo lectura. No se inició Auth, PostgREST, Storage ni ningún emisor de correos/mensajes.

Las copias de trabajo y registros están en la subcarpeta privada `validation-bootstrap` del respaldo:

1. `roles.local.sql`: se comentó **solo** `CREATE ROLE supabase_admin;`, porque `initdb --username=supabase_admin` ya había creado ese rol. Su `ALTER ROLE` original, configuración y todas las concesiones se conservaron. La comparación posterior del volcado de roles, sin contraseñas, coincide con el original: 19 roles declarados y 26 membresías explícitas.
2. `restore.local.sql`: se generó desde `database.dump` con `pg_restore --create --file=-`. Se conservaron todas las sentencias originales. Se añadieron cambios de identidad de sesión únicamente alrededor de la creación de `pg_stat_statements`, `pgcrypto` y `uuid-ossp`:

   ```sql
   SET SESSION AUTHORIZATION postgres;
   -- CREATE EXTENSION original, sin modificar
   SET SESSION AUTHORIZATION supabase_admin;
   ```

   Esto reproduce los propietarios de funciones y privilegios iniciales de esas extensiones observados en el origen. Crearlas todas como `supabase_admin` cambiaba esos propietarios. `supabase_vault` se creó como `supabase_admin`, coincidiendo con el origen.
3. Solo en el clúster local aislado, `postgres` tuvo `SUPERUSER` durante esa restauración para crear las extensiones con sus propietarios originales. Se restableció a `NOSUPERUSER` en un bloque `finally` y se comprobó después. No se dejó ningún atributo adicional ni se añadió ninguna concesión permanente. La comparación de roles coincide íntegramente.

Los intentos anteriores se conservaron. No se eliminaron datos: la primera base restaurada local se renombró a `cai_first_restore` antes de crear de nuevo `postgres`. No se modificaron propietarios de tablas financieras para acomodar la restauración.

Para reproducir el procedimiento en **otro clúster vacío y aislado**, se necesita inicializarlo con el mismo usuario inicial; importar `roles.local.sql`; renombrar la base `postgres` vacía creada por `initdb`; habilitar temporalmente `SUPERUSER` para `postgres` solo allí; importar `restore.local.sql` con `psql -X -v ON_ERROR_STOP=1`; y restablecer inmediatamente `NOSUPERUSER`, incluso ante error. Nunca ejecutar estas adaptaciones sobre Supabase alojado. Las comprobaciones de comparación deben completarse antes de aceptar el nuevo destino.

## Resultados ejecutados

| Verificación | Resultado |
| --- | --- |
| Integridad de los diez archivos originales SHA-256 | Coincide |
| Restauración de roles y archivo completo | Sin errores en el intento corregido |
| 63 tablas, 262 filas totales | Conteos y huellas de contenido coinciden por tabla |
| Datos Auth y dependencias del perfil | Coinciden por tabla, incluidos todos sus campos originales |
| 129 funciones | Firma, propietario, SECURITY DEFINER, configuración y huella de definición coinciden |
| 275 restricciones | Definición y estado de validación coinciden |
| 199 índices | Definición y estados de validez/preparación coinciden |
| 32 triggers no internos | Definición y estado habilitado coinciden |
| 7 secuencias | Propietario, valor y `is_called` coinciden |
| Historial de migraciones | Exactamente 001–005; las cinco filas completas también coinciden en la comparación de tabla |
| Esquema completo | Mismas 1.278 sentencias SQL, incluidos propietarios, ACL, RLS, funciones y privilegios predeterminados |
| Roles y membresías | Coinciden, sin hashes de contraseñas globales por diseño |
| Crédito, stock y totales de movimientos | Coinciden con la captura original |
| Seguridad e integridad en PostgreSQL real restaurado | Aprobadas, consultas de solo lectura |
| `npm run test:credit` | 83 aprobadas, aproximadamente un minuto |
| `npm run check:credit` | Aprobado |

La comparación del esquema usa sentencias SQL completas, conservando cuerpos de funciones, propietarios y ACL; solo neutraliza comentarios externos, separadores del cliente y diferencias de orden entre objetos. Las definiciones de funciones también se compararon por separado con su huella de catálogo. Las filas se compararon por identidad de tabla, sin depender del orden de ejecución paralelo de consultas. Se fijó `search_path=public` para evitar falsos cambios por nombres de objetos visibles en la sesión administrativa.

Los 23 objetos de tabla de `pos` mantienen propietario `pos_owner` y RLS habilitada. El origen no contiene políticas `pg_policy` y el destino tampoco; esto no se interpretó como una autorización para añadir políticas. Las funciones de acceso siguen siendo la vía autorizada. Se comprobaron la ausencia de CREATE para `pos_owner`, la denegación de lectura directa de perfiles a roles del navegador, EXECUTE de RPC/puente, rechazo de contextos no confiables/claims ausentes y ausencia de devolución de perfiles ajenos. La emulación local del contexto del gateway no verifica firmas JWT ni sustituye una prueba HTTP de Supabase Auth.

**Límite financiero de la evidencia real:** el origen capturado no tiene ventas, pagos, créditos, abonos, existencias ni movimientos de caja. Sí conserva su perfil y métodos de pago. La igualdad de tablas y saldos reales en esos módulos se verificó sobre conjuntos vacíos, sin inventar transacciones. Las 83 pruebas adicionales se ejecutaron con fixtures ficticios en PGlite independiente; cubren ventas, créditos, abonos, caja, inventario, devoluciones, idempotencia, permisos y actualización 006–008. No son una prueba de concurrencia multi-conexión ni de migraciones aplicadas a la base restaurada real.

## Evidencias y límites de recuperación

En `validation-bootstrap`: `comparison.json`, `restored-catalog.json`, `roles-diff.json`, `schema-diff.json`, `adaptations.json`, `extension-adaptations.json`, `check-restored-security.sql`, registros de ejecución y `validation-result.json`. Estos archivos son privados y no deben subirse a Git. El manifiesto original conserva el estado histórico del primer intento fallido; el resultado actual se acredita en el informe separado de validación, sin reescribir el manifiesto original.

El contenedor se detuvo al terminar; los volúmenes y archivos se conservaron. Para reutilizar el volumen, arrancar PostgreSQL directamente con la misma imagen y aislamiento: el comando inicial de ese contenedor ejecutaba `initdb` y no debe repetirse sobre un volumen ya inicializado.

Se ha demostrado la recuperación lógica del contenido PostgreSQL de esa captura. El procedimiento oficial de [Supabase backup/restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore) trabaja con roles, esquema, datos e historial, pero su CLI filtra objetos administrados para destinos Supabase ya inicializados. Este respaldo deliberadamente conserva los objetos administrados y el historial en un archivo completo, por lo que se restauró sobre un clúster vacío de la imagen compatible. No se aplicaron las recomendaciones de omitir propietarios o membresías para ocultar errores. La guía de [restauración a Supabase autohospedado](https://supabase.com/docs/guides/self-hosting/restore-from-platform) explica esa diferencia.

No fue necesario iniciar todo el stack Supabase para validar PostgreSQL. Un ensayo de recuperación del servicio completo requiere además Auth/PostgREST y configuración de plataforma: claves JWT/API, contraseñas de conexión de roles LOGIN, OAuth, SMTP, Storage binario, Edge Functions y demás secretos/configuración externos no se reconstruyen con este dump. Las contraseñas de roles PostgreSQL se excluyeron expresamente; los hashes de contraseñas de `auth.users` sí están en los datos respaldados. Vault, factores MFA y clientes OAuth consultados estaban vacíos; no se afirma haber probado descifrado de datos con claves externas. Las restricciones de exposición Data API son configuración de servicio, no se certifican solo con catálogos PostgreSQL.

## Siguientes pasos

Antes de producción: conservar una segunda copia protegida independiente; comprobar la vigencia de esta captura y controlar escritores durante cualquier mantenimiento; verificar de nuevo historial y objetos parciales; ensayar 006→007→008 en una copia aislada de la restauración, comparar filas/saldos y ejecutar sus verificaciones. Esta validación no ejecutó 006–008 sobre producción ni sobre la base PostgreSQL restaurada. No se accedió a producción en esta etapa, no hubo operaciones comerciales, commits ni despliegues. La aplicación de migraciones en producción continúa requiriendo autorización explícita.
