# NutriTrace privado en ChatGPT: operación OAuth y PAT

El fork está publicado en Railway; el propietario confirmó login OAuth e instalación en ChatGPT. El refresco del catálogo está en diagnóstico; login correcto no demuestra que el resource server acepte el token. Gym Log conserva su autenticación. NutriTrace es un **resource server** OAuth: el proveedor externo gestiona login, consentimiento, PKCE, códigos, refresh y revocación del grant.

## Configuración del servidor

Todos los valores se provisionan mediante el gestor privado de Railway. El frontend recibe únicamente la capacidad `body_measurements_source`. Nunca introducir PAT, JWT, client secret ni refresh tokens en un chat, Git, capturas o variables VITE.

| Variable | Uso |
|---|---|
| `BODY_MEASUREMENTS_SOURCE` | `internal` por defecto; `gym-log` para esta instalación personal |
| `MCP_ENABLED` | `1` para el transporte MCP, independiente de REST público |
| `MCP_WRITE_ENABLED` | `1` para registros nutricionales y metas con scopes apropiados |
| `MCP_DESTROY_ENABLED` | `1` para crear alimentos y editar/eliminar una entrada nutricional con `mcp:destroy`; `0` las desactiva para OAuth y PAT |
| `MCP_OAUTH_ENABLED` | `1` activa OAuth, `0` mantiene PAT sin OAuth |
| `MCP_OAUTH_RESOURCE_URL` | HTTPS canónico completo de `/api/mcp`, incluyendo BASE_URL |
| `MCP_OAUTH_ISSUER` | Issuer HTTPS exacto del proveedor, terminado en `/` |
| `MCP_OAUTH_OWNER_SUB` | `sub` exacto del propietario en ese issuer |
| `MCP_OAUTH_USER_ID` | ID positivo de la cuenta NutriTrace existente que posee los datos; no asumir 1 |
| `MCP_OAUTH_CLIENT_ID` | Cliente ChatGPT autorizado, verificado contra `azp`/`client_id` |
| `MCP_OAUTH_VALID_AFTER` | Opcional: fecha ISO de corte de emisión para rechazar JWT anteriores |
| `ALLOWED_ORIGINS` | Orígenes de navegador expresamente confiados; sin comodines. Las peticiones servidor-servidor sin Origin son válidas con autenticación |

Enviar fechas explícitas del día mexicano en registros y consultas. Si se quieren defaults de fecha locales en el servidor, configurar `TZ=America/Mexico_City` y comprobarlos; no asumir que Railway usa la zona del teléfono.

No hace falta `OPENAI_API_KEY` ni guardar el client secret OAuth en NutriTrace. Las credenciales del cliente predefinido se suministran solo al formulario privado de conexión ChatGPT. No reutilizar sesiones de la PWA como credencial MCP.

Discovery público: `/.well-known/oauth-protected-resource` y `/.well-known/oauth-protected-resource/api/mcp`. Con BASE_URL `/nutri`, la segunda ruta es `/.well-known/oauth-protected-resource/nutri/api/mcp`; ambas permanecen en la raíz del host. Publican únicamente resource, issuer y scopes; no identificadores del dueño ni datos de salud. Sin OAuth configurado responden de forma cerrada. Ningún dato MCP se publica sin Bearer válido.

## Auth0: configuración manual posterior

1. Reutilizar el tenant que ya usa Gym, sin cambiar su API, cliente ni toggles globales automáticamente.
2. Crear una API **NutriTrace** cuyo identifier/audience sea exactamente `MCP_OAUTH_RESOURCE_URL`. Usar RS256 y access tokens cortos (propuesta: 300 segundos).
3. Definir `mcp:read`, `mcp:write`, `mcp:goals:write` y **`mcp:destroy`**; asignarlos solo al propietario. La aplicación exige el scope del grant; si existe `permissions`, lo usa como límite adicional, nunca como unión que amplíe el consentimiento.
4. Crear un cliente **ChatGPT NutriTrace** separado: Authorization Code con PKCE S256. Configurar renovación mediante refresh token con rotación, límites de duración y offline access según permita el tenant/cliente. No pedir grants de máquina para suplantar al propietario.
5. Comprobar discovery del authorization server, JWKS y compatibilidad del parámetro `resource` con la audience. No modificar ajustes globales que afecten Gym sin revisar el efecto. NutriTrace solo obtiene JWKS del discovery del issuer configurado, por HTTPS y en su mismo origen; no sigue `jku` del JWT.
6. Registrar la redirect URI **exacta que muestre ChatGPT**, sin inventar ni reutilizar por memoria una callback antigua. Mantener permitida solo la identidad del dueño. Comprobar `sub`, cliente, audience y permisos en el entorno del proveedor, sin copiar tokens a documentación o logs.
7. Configurar las variables privadas de Railway. La cuenta SQLite debe existir. OAuth no autocrea cuentas, no asigna el primer usuario ni adopta datos anónimos.

Referencia del proveedor: [compatibilidad resource/issuer](https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile). Contrato: [autorización MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

## Permisos y herramientas

La fase 1 de planificación amplía este catálogo con comidas/recetas, plantillas
semanales recurrentes, excepciones por fecha, inventario, listas de compras y
versiones. Contratos, permisos, migración, pruebas y actualización de la conexión:
[Planificación y compras](planning-shopping.md). Las restricciones anteriores
sobre administrar recetas mediante MCP se sustituyen por los contratos de esa
ampliación cuando esta versión del servidor esté desplegada.

En modo Gym, ChatGPT puede consultar biblioteca, comidas, diario, totales, perfil nutricional y metas. Se reutilizan `log_food`, `log_meal` y `log_water`. Para registrar, los alimentos deben existir en catálogo; `create_food` permite crear uno con confirmación y permiso adicional; `log_meal` registra comidas guardadas, no recetas de la biblioteca como si fueran comidas. Las recetas se administran desde la PWA o con `save_catalog_meal`; `record_planned_meal` registra una receta planificada respetando su rendimiento. Los nuevos productos también pueden crearse mediante MCP. No reconstruir recetas ni alterar las guardadas por registrar un snack.

No se publica ni ejecuta `log_body_stat` o `get_body_composition` en modo Gym. No hay `get_body_stats` nuevo. El registro corporal corresponde a `log_body_measurement` de Gym. OAuth admite `create_food`, `edit_diary_entry` y `delete_diary_entry` únicamente con `mcp:destroy`, `MCP_DESTROY_ENABLED=1` y `confirm:true`. Ninguna permite borrar días, historiales, bases de datos ni medidas corporales. La UI nutricional original conserva sus correcciones de cantidades.

Scopes por tool: las tres tools de administración requieren `mcp:destroy` (no se deduce de `mcp:read` ni `mcp:write`); lectura `mcp:read`; registros `mcp:write`; `set_nutrition_goals` exige **ambos** `mcp:write` y `mcp:goals:write`, además del flag de escritura. `tools/list` describe las herramientas OAuth habilitadas y sus scopes; descubrir una herramienta no autoriza ejecutarla. PAT conserva filtrado de catálogo por scopes. Se corrigió la lectura accidental con PAT write-only.

### Crear alimentos y corregir entradas

Para habilitar esta ampliación en una conexión existente, añadir `mcp:destroy` a la API NutriTrace y al permiso del dueño en Auth0, concederlo también en el grant, configurar `MCP_DESTROY_ENABLED=1` en Railway y refrescar el catálogo/reautorizar ChatGPT. No basta añadirlo a RBAC `permissions`: debe estar en el claim `scope` consentido. No se han aplicado estos cambios al tenant real.

`create_food` conserva la validación de nutrientes y duplicados y crea exclusivamente un alimento del usuario autenticado. No edita recetas guardadas ni mediciones.

Para `edit_diary_entry` y `delete_diary_entry`:

1. Leer `list_diary_entries` para la fecha explícita; el rango también devuelve `items_revision` por día.
2. Seleccionar `items[n].uuid` como `entry_id`. Pasar `items_revision` como **`expected_revision`** y `confirm:true`. El usuario debe haber solicitado la corrección/borrado concreto; el argumento no sustituye los controles de aprobación del cliente.
3. Solo para entradas legadas sin UUID, usar `entry_index` con la misma revisión obligatoria. Si se pasan ambos selectores, deben coincidir.
4. El servidor relee exclusivamente el día del usuario autenticado y comprueba revisión/objetivo dentro de la transacción. Cualquier cambio en los alimentos, incluso insertar/reordenar otra entrada, produce conflicto: releer y confirmar el nuevo objetivo. No reintentar con el índice anterior.

La revisión cubre el arreglo completo de alimentos; no contiene secretos ni cambia al leer. Este requisito también se aplica a PAT: los clientes anteriores que solo enviaban índices deben actualizarse. Las respuestas de edición/borrado incluyen la nueva revisión y el UUID cuando existe. Se preservan agua, notas del día, `body_stats` y la fila del día, incluso al retirar su último alimento. Los borrados con UUID generan tombstones de sync; las ediciones actualizan `updatedAt` para reconciliar clientes offline. Los legados sin UUID no ofrecen la misma deduplicación offline: resolver colas antiguas antes de corregirlos.

Una respuesta incierta requiere releer el diario y resolver el resultado; no reutilizar ciegamente la revisión. No existen herramientas de borrado masivo ni de medidas corporales en este catálogo.

### Cambios explícitos de metas

Primero ejecutar `get_goals`. En `set_nutrition_goals`:

- `targets`: subconjunto no vacío de `calories` (kcal), `proteins`, `carbohydrates`, `fat` (g), `water` (ml), con valores positivos finitos.
- `expected`: objeto completo previo de cada nutriente modificado; `water` usa el valor previo `water_goal_ml`; `null` si no existía.
- `confirm:true`: intención explícita del usuario, además de los controles de autorización/aprobación del cliente.

Se compara y escribe dentro de una transacción. Un cambio concurrente produce `GOAL_CONFLICT` y requiere releer, nunca sobrescribir a ciegas. Mantiene otras metas, micronutrientes, preferencias y banderas de visualización. Rechaza metas semanales, porcentuales y autoajustadas. No cambia peso, TDEE, objetivos corporales ni el modo calórico. En modo Gym la vista calórica efectiva es fija aunque una preferencia histórica fuera adaptive; no se activa ese algoritmo.

Los registros append **no son idempotentes**: alimento, comida y agua pueden duplicarse si se repiten. Ante respuesta perdida, consultar diario/totales y resolver con el usuario. No configurar reintentos automáticos de escrituras. Las annotations son descripciones, no controles de seguridad ni garantía de confirmación humana por llamada.

La integración de comidas planificadas con el diario añade `get_diary_plan` y
`record_planned_meal` (lectura y escritura respectivamente). Contratos,
concurrencia y comprobación tras desplegar: [Diario planificado](planned-diary.md).

## Instalar como aplicación privada de ChatGPT

Después de desplegar y verificar HTTPS/discovery/401:

1. En la misma cuenta donde Gym ya lee/escribe, abrir la opción disponible para añadir un servidor MCP personalizado: Apps/Developer Mode o Plugins → Add custom MCP server según la interfaz vigente.
2. Introducir la URL canónica completa y seleccionar OAuth obligatorio. Usar el cliente predefinido y sus campos privados; completar la callback exacta en Auth0. No seleccionar acceso anónimo.
3. Iniciar sesión como propietario y consentir los scopes nutricionales necesarios. Instalar la conexión privada; no enviarla al directorio público ni cambiar de plan por defecto.
4. En un chat compatible, seleccionar NutriTrace, consultar metas/biblioteca y registrar una porción de un alimento existente y agua para una fecha explícita. Comprobar el resultado en la PWA.
5. Cambiar una meta explícita con lectura previa y comparar el resultado en Goals/Diary. Con datos de prueba acordados, crear un alimento y editar/eliminar una sola entrada con lectura previa y confirmación; comprobarlo en PWA. Borrar días/historiales o registrar/modificar/eliminar medidas corporales debe fallar/no estar disponible.
6. Seleccionar ambas apps y consultar nutrición y medidas en sus respectivas fuentes. Registrar peso usando Gym exclusivamente; no se produce sincronización entre bases.
7. Tras cambiar scopes/descriptores, refrescar la conexión y completar nuevo consentimiento si corresponde. Verificar escritura en la cuenta y superficie reales: un mock o una prueba con Codex no demuestra instalación ChatGPT.

Guías oficiales: [autenticación](https://developers.openai.com/plugins/build/auth), [conexión y pruebas](https://developers.openai.com/plugins/deploy/connect-chatgpt). El nombre de la pantalla y la disponibilidad por plan/superficie pueden cambiar. El usuario ya confirmó Gym con lectura/escritura en su cuenta personal; falta demostrar NutriTrace allí. No se garantiza escritura en deep research, todos los modelos o todas las interfaces móviles.

## Refresh, revocación y respuesta a incidentes

El proveedor y ChatGPT renuevan los tokens. NutriTrace valida cada access token con firma RS256, issuer/audience, exp/iat obligatorios, nbf si existe, dueño, cliente, scopes y existencia de la cuenta local. No guarda refresh tokens ni aplica fallback de OAuth a PAT/cookie. Rechaza JWT Gym e ID tokens con audience de cliente.

Revocar/desconectar el grant o refresh token impide renovar, pero un JWT ya emitido puede funcionar hasta su expiración. Verificar ese TTL residual, no prometer revocación instantánea. Para corte inmediato de toda la vía OAuth: `MCP_OAUTH_ENABLED=0` y reinicio, conservando PAT. Antes de reactivar, revocar el grant y fijar `MCP_OAUTH_VALID_AFTER` para rechazar emisiones antiguas. Revocar un PAT elimina su acceso en la siguiente petición. Cerrar sesión PWA no revoca por sí solo conexiones OAuth.

La validación local de JWT no ofrece revocación selectiva instantánea por conexión. Se necesitaría introspección/estado adicional si ese requisito apareciera; no se implementó infraestructura nueva para el único usuario.

## Diagnóstico de “Authentication succeeded, action discovery failed”

El 2026-10-25 los logs aportados por el propietario mostraron `POST /api/mcp` → `403` con cuerpo de 413 bytes después de probes `401`. No había evidencia de `tools/list` → `200`. Los probes públicos sin credenciales confirmaron metadata `200`, challenge `401` y rechazo `403` de `Origin: https://chatgpt.com` cuando ese origen no está permitido. Este último probe es de diagnóstico, no prueba de que ChatGPT esté enviando ese Origin.

Defecto local reproducido y corregido: SDK 1.30 ignora el `securitySchemes` principal de `registerTool`. El transporte ahora conserva ese campo en el JSON-RPC real de `tools/list`, además de `_meta.securitySchemes`. No modifica el despacho de herramientas ni concede permisos.

`node --experimental-global-webcrypto --test scripts/mcp-discovery.test.js` usa el cliente oficial MCP Streamable HTTP, SQLite temporal, JWT RSA sintético y los routers reales. Negocia `initialize`, envía `notifications/initialized` y obtiene `tools/list` dos veces. Verifica las seis herramientas `get_goals`, `search_foods`, `log_food`, `create_food`, `edit_diary_entry`, `delete_diary_entry`, catálogo estable de 43 herramientas en modo Gym (19 originales, 22 de planificación y 2 de diario planificado), validación de todos los esquemas JSON y ambos descriptores OAuth. **Es evidencia local, no una llamada autenticada al Railway real.**

### Leer el motivo de un rechazo sin exponer credenciales

Cada POST MCP registra una línea `[mcp:diagnostic]` con el mismo `request_id` que el log HTTP, método RPC reconocido, estado, versión, scopes MCP efectivos, número de tools y motivo enumerado. No registra Authorization, cookies, JWT, `sub`, cliente, ID SQLite, argumentos, mensajes arbitrarios ni datos de salud. No requiere habilitar `LOG_LEVEL=trace` ni nuevas variables privadas.

Después del despliegue, repetir una sola vez Refresh tools y buscar ese `request_id`:

| `reason` | Corrección concreta, en configuración privada |
|---|---|
| `owner_mismatch` | `MCP_OAUTH_OWNER_SUB` debe ser el User ID/`sub` exacto de la identidad Auth0 que completó el login; no username/email ni ID SQLite |
| `client_mismatch` | `MCP_OAUTH_CLIENT_ID` debe ser el Client ID del cliente predefinido configurado en esta conexión ChatGPT NutriTrace; no el de Gym ni el identifier de la API |
| `local_user_missing` | Verificar el ID con la sesión PWA mediante `GET /api/auth/me` y configurar ese ID en `MCP_OAUTH_USER_ID`, apuntando al volumen/cuenta existentes |
| `auth_scope` | El token carece de todos los scopes MCP admitidos. Conceder al dueño los scopes de la API NutriTrace y solicitarlos/consentirlos en el grant. Si hay RBAC `permissions`, también debe permitirlos. Reautorizar la conexión |
| `origin_rejected` | Solo si la petición real incluye ese Origin: añadir el origen exacto a `ALLOWED_ORIGINS` conservando los existentes; sin comodines |
| `jwt_issuer` / `jwt_audience` | Comparar issuer con discovery Auth0 y audience con la URL canónica completa `/api/mcp`; revisar resource/audience del grant |
| `jwt_expired` / `jwt_time` | Renovar/reautorizar; revisar TTL, reloj y `MCP_OAUTH_VALID_AFTER` sin relajar validación |
| `jwt_key` / `jwt_signature` / `jwt_invalid` | Revisar emisor/JWKS y token de acceso emitido; no usar ID token, JWT de Gym o sesión PWA |

Un `403` no demuestra por sí solo qué fila aplica. La validación se mantiene cerrada. Un token con `mcp:read` sí descubre el catálogo OAuth habilitado; scopes de escritura/destroy se comprueban por llamada. Sin ningún scope MCP se rechaza antes del SDK, nunca se devuelve una lista vacía como supuesto éxito.

### Versiones, transporte y refresh

La dependencia actual soporta versiones hasta **2025-11-25**. En versiones compatibles, initialize/list responden `200 application/json`; la notificación initialized responde `202`. Accept debe incluir **application/json y text/event-stream**; omitir uno produce `406`. Content-Type de petición debe ser application/json (`415` de otro modo). No se requieren sesiones ni GET persistente. GET `405` es intencional.

El protocolo 2026-07-28 introduce `server/discover` y metadata por petición. Este servidor sigue la era initialize: una petición con ese header moderno devuelve `400`; un `server/discover` sin header moderno devuelve JSON-RPC `-32601`. Un cliente de ambas eras debe hacer fallback a initialize y usar la versión negociada. No anunciar soporte 2026 sin implementar su contrato. Los logs de la petición real permiten comprobar si el cliente hizo fallback; los probes locales no identifican la versión que ChatGPT emplea en una cuenta concreta.

El discovery público de Auth0 de esta instalación anuncia `offline_access` y grant `refresh_token`. Eso no demuestra que el cliente/API/grant particular estén habilitados o que se haya emitido un refresh token. Configurar Allow Offline Access en la API, grant Refresh Token en el cliente y rotación; reautorizar si cambió. La falta de renovación puede explicar pérdida de acceso al expirar; no se atribuye un `403` inmediato a refresh sin evidencia.

Fuentes: [OpenAI: autenticación](https://developers.openai.com/plugins/build/auth), [descriptores y espejo de seguridad](https://developers.openai.com/plugins/reference), [MCP: compatibilidad entre eras](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning). No habilitar acceso anónimo para eludir este problema.
