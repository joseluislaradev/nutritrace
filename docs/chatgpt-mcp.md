# NutriTrace privado en ChatGPT: operación OAuth y PAT

Implementación local del fork; no se ha configurado Auth0, instalado la app ni desplegado con esta tarea. Gym Log conserva su autenticación. NutriTrace es un **resource server** OAuth: el proveedor externo gestiona login, consentimiento, PKCE, códigos, refresh y revocación del grant.

## Configuración del servidor

Todos los valores se provisionan mediante el gestor privado de Railway. El frontend recibe únicamente la capacidad `body_measurements_source`. Nunca introducir PAT, JWT, client secret ni refresh tokens en un chat, Git, capturas o variables VITE.

| Variable | Uso |
|---|---|
| `BODY_MEASUREMENTS_SOURCE` | `internal` por defecto; `gym-log` para esta instalación personal |
| `MCP_ENABLED` | `1` para el transporte MCP, independiente de REST público |
| `MCP_WRITE_ENABLED` | `1` para registros nutricionales y metas con scopes apropiados |
| `MCP_DESTROY_ENABLED` | Mantener `0`; OAuth nunca publica las herramientas destroy |
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
3. Definir `mcp:read`, `mcp:write` y `mcp:goals:write`; asignarlos solo al propietario. La aplicación exige el scope del grant; si existe `permissions`, lo usa como límite adicional, nunca como unión que amplíe el consentimiento.
4. Crear un cliente **ChatGPT NutriTrace** separado: Authorization Code con PKCE S256. Configurar renovación mediante refresh token con rotación, límites de duración y offline access según permita el tenant/cliente. No pedir grants de máquina para suplantar al propietario.
5. Comprobar discovery del authorization server, JWKS y compatibilidad del parámetro `resource` con la audience. No modificar ajustes globales que afecten Gym sin revisar el efecto. NutriTrace solo obtiene JWKS del discovery del issuer configurado, por HTTPS y en su mismo origen; no sigue `jku` del JWT.
6. Registrar la redirect URI **exacta que muestre ChatGPT**, sin inventar ni reutilizar por memoria una callback antigua. Mantener permitida solo la identidad del dueño. Comprobar `sub`, cliente, audience y permisos en el entorno del proveedor, sin copiar tokens a documentación o logs.
7. Configurar las variables privadas de Railway. La cuenta SQLite debe existir. OAuth no autocrea cuentas, no asigna el primer usuario ni adopta datos anónimos.

Referencia del proveedor: [compatibilidad resource/issuer](https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile). Contrato: [autorización MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

## Permisos y herramientas

En modo Gym, ChatGPT puede consultar biblioteca, comidas, diario, totales, perfil nutricional y metas. Se reutilizan `log_food`, `log_meal` y `log_water`. Los alimentos deben existir en catálogo; `log_meal` registra comidas guardadas, no recetas de la biblioteca como si fueran comidas. Para recetas y nuevos productos, usar los flujos originales de la PWA. No reconstruir recetas ni alterar las guardadas por registrar un snack.

No se publica ni ejecuta `log_body_stat` o `get_body_composition` en modo Gym. No hay `get_body_stats` nuevo. El registro corporal corresponde a `log_body_measurement` de Gym. OAuth nunca concede `create_food`, `edit_diary_entry` o `delete_diary_entry` de la categoría destroy. La UI nutricional original conserva sus correcciones de cantidades.

Scopes por tool: lectura `mcp:read`; registros `mcp:write`; `set_nutrition_goals` exige **ambos** `mcp:write` y `mcp:goals:write`, además del flag de escritura. `tools/list` describe las herramientas OAuth habilitadas y sus scopes; descubrir una herramienta no autoriza ejecutarla. PAT conserva filtrado de catálogo por scopes. Se corrigió la lectura accidental con PAT write-only.

### Cambios explícitos de metas

Primero ejecutar `get_goals`. En `set_nutrition_goals`:

- `targets`: subconjunto no vacío de `calories` (kcal), `proteins`, `carbohydrates`, `fat` (g), `water` (ml), con valores positivos finitos.
- `expected`: objeto completo previo de cada nutriente modificado; `water` usa el valor previo `water_goal_ml`; `null` si no existía.
- `confirm:true`: intención explícita del usuario, además de los controles de autorización/aprobación del cliente.

Se compara y escribe dentro de una transacción. Un cambio concurrente produce `GOAL_CONFLICT` y requiere releer, nunca sobrescribir a ciegas. Mantiene otras metas, micronutrientes, preferencias y banderas de visualización. Rechaza metas semanales, porcentuales y autoajustadas. No cambia peso, TDEE, objetivos corporales ni el modo calórico. En modo Gym la vista calórica efectiva es fija aunque una preferencia histórica fuera adaptive; no se activa ese algoritmo.

Los registros append **no son idempotentes**: alimento, comida y agua pueden duplicarse si se repiten. Ante respuesta perdida, consultar diario/totales y resolver con el usuario. No configurar reintentos automáticos de escrituras. Las annotations son descripciones, no controles de seguridad ni garantía de confirmación humana por llamada.

## Instalar como aplicación privada de ChatGPT

Después de desplegar y verificar HTTPS/discovery/401:

1. En la misma cuenta donde Gym ya lee/escribe, abrir la opción disponible para añadir un servidor MCP personalizado: Apps/Developer Mode o Plugins → Add custom MCP server según la interfaz vigente.
2. Introducir la URL canónica completa y seleccionar OAuth obligatorio. Usar el cliente predefinido y sus campos privados; completar la callback exacta en Auth0. No seleccionar acceso anónimo.
3. Iniciar sesión como propietario y consentir los scopes nutricionales necesarios. Instalar la conexión privada; no enviarla al directorio público ni cambiar de plan por defecto.
4. En un chat compatible, seleccionar NutriTrace, consultar metas/biblioteca y registrar una porción de un alimento existente y agua para una fecha explícita. Comprobar el resultado en la PWA.
5. Cambiar una meta explícita con lectura previa y comparar el resultado en Goals/Diary. Pedir una operación destructiva y registro corporal a NutriTrace: deben fallar/no estar disponibles.
6. Seleccionar ambas apps y consultar nutrición y medidas en sus respectivas fuentes. Registrar peso usando Gym exclusivamente; no se produce sincronización entre bases.
7. Tras cambiar scopes/descriptores, refrescar la conexión y completar nuevo consentimiento si corresponde. Verificar escritura en la cuenta y superficie reales: un mock o una prueba con Codex no demuestra instalación ChatGPT.

Guías oficiales: [autenticación](https://developers.openai.com/plugins/build/auth), [conexión y pruebas](https://developers.openai.com/plugins/deploy/connect-chatgpt). El nombre de la pantalla y la disponibilidad por plan/superficie pueden cambiar. El usuario ya confirmó Gym con lectura/escritura en su cuenta personal; falta demostrar NutriTrace allí. No se garantiza escritura en deep research, todos los modelos o todas las interfaces móviles.

## Refresh, revocación y respuesta a incidentes

El proveedor y ChatGPT renuevan los tokens. NutriTrace valida cada access token con firma RS256, issuer/audience, exp/iat obligatorios, nbf si existe, dueño, cliente, scopes y existencia de la cuenta local. No guarda refresh tokens ni aplica fallback de OAuth a PAT/cookie. Rechaza JWT Gym e ID tokens con audience de cliente.

Revocar/desconectar el grant o refresh token impide renovar, pero un JWT ya emitido puede funcionar hasta su expiración. Verificar ese TTL residual, no prometer revocación instantánea. Para corte inmediato de toda la vía OAuth: `MCP_OAUTH_ENABLED=0` y reinicio, conservando PAT. Antes de reactivar, revocar el grant y fijar `MCP_OAUTH_VALID_AFTER` para rechazar emisiones antiguas. Revocar un PAT elimina su acceso en la siguiente petición. Cerrar sesión PWA no revoca por sí solo conexiones OAuth.

La validación local de JWT no ofrece revocación selectiva instantánea por conexión. Se necesitaría introspección/estado adicional si ese requisito apareciera; no se implementó infraestructura nueva para el único usuario.
