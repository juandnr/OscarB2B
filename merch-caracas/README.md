# Merch Caracas: seguimiento de WhatsApp con IA

Lee las conversaciones del WhatsApp Business compartido (coexistencia con 360dialog), asigna cada cliente a un vendedor por rotación, avanza el pipeline de HubSpot y crea las tareas de cada vendedor. Los vendedores solo contestan en WhatsApp y marcan tareas como completadas en la app de HubSpot.

```
Cliente ──► App WhatsApp Business ◄── Vendedores contestan aquí
                   │ coexistencia
                   ▼
              360dialog  (webhooks: messages + smb_message_echoes + history)
                   ▼
   Supabase: Edge Function "merch" ──► Postgres (esquema merch)
             (cron cada 3–15 min)   ├──► Claude API (clasifica la conversación → JSON)
                                    └──► HubSpot (contacto, negocio, propietario, tareas, notas)
```

## Dónde corre

**Supabase, en el plan gratis.** A pedido de Oscar, para no pagar servidor, los cinco flujos corren como una Edge Function de Supabase en vez de n8n. Las tareas programadas usan el cron de Supabase y la base es la del proyecto. La lógica y las reglas son las mismas. Instalación paso a paso, solo desde el panel de Supabase: **`supabase/INSTALAR.md`**.

**Alternativa: n8n autoalojado.** Los mismos cinco flujos también están listos para n8n, en `n8n/workflows/`, con un servidor preparado en `docker-compose.yml` y `deploy/`. Es útil si más adelante se quiere n8n; el resto de este README describe ese camino.

## Contenido

| Carpeta | Qué hay |
|---|---|
| `db/migraciones/` | `001_esquema.sql` (tablas de la especificación) y `002_implementacion.sql` (columnas extra, tabla `analisis` y funciones que usan los flujos) |
| `hubspot/setup.js` | Crea el pipeline "WhatsApp Ventas", las propiedades y los motivos de pérdida; imprime los IDs para `.env` |
| `n8n/workflows/` | Los 5 flujos listos para importar en n8n (F1–F5) |
| `src/` | Toda la lógica (normalización de webhooks, horario laboral, reglas, Claude, HubSpot, pasos de cada flujo) |
| `prompts/clasificador.md` | Prompt del sistema de F2 |
| `scripts/` | Migraciones, configuración del webhook de 360dialog y verificación de la instalación |
| `db/revision_f2.sql` | Consultas para revisar a mano el modo sombra |
| `supabase/` | Instalación en Supabase: `instalar.sql` (SQL Editor), `functions/merch/index.ts` (Edge Function) y guía `INSTALAR.md` |
| `docker-compose.yml`, `deploy/` | Alternativa con n8n: Postgres + n8n + HTTPS en un servidor propio, con guía en `deploy/INSTALAR.md` |
| `test/` | Pruebas (`npm test`) |

La lógica vive en `src/` y está cubierta por pruebas. `node supabase/construir.js` la empaqueta en la función de Supabase y `npm run n8n:construir` en los Code nodes de n8n, así que las dos corren exactamente el código probado. **No edites el código dentro de Supabase ni de n8n**: cambia `src/`, reconstruye y vuelve a pegar o importar.

## Requisitos (camino con n8n)

- **n8n autoalojado** (probado con n8n 2.41.3). La configuración se lee con `$env`, que n8n Cloud no permite.
- **Postgres** 14 o superior (probado con 16).
- **Node.js** 22 o superior para los scripts y las pruebas.
- 360dialog con coexistencia activa, HubSpot con un usuario por vendedor y una API key de Anthropic.

## Puesta en marcha con n8n

Con Supabase, sigue `supabase/INSTALAR.md`, que respeta el mismo orden. Con n8n, sigue el orden de construcción de la especificación. Cada paso tiene su criterio de listo.

```bash
cd merch-caracas
npm install
cp .env.example .env      # y completa los valores a medida que avanzas
```

### 1. HubSpot

1. En HubSpot crea una app privada y copia el token en `HUBSPOT_PRIVATE_APP_TOKEN`. Permisos: `crm.objects.contacts.read/write`, `crm.objects.deals.read/write`, `crm.objects.owners.read`, `crm.schemas.deals.read/write`. Si alguna llamada responde `403 MISSING_SCOPES`, el mensaje de HubSpot dice qué permiso falta: agrégalo a la app.
2. Ejecuta:
   ```bash
   npm run hubspot:setup
   ```
   Crea (o completa, si ya existe) el pipeline con sus 9 etapas, las propiedades `wa_telefono`, `producto`, `cantidad`, `fecha_entrega`, `empresa_cliente`, `resumen_ia` y `motivo_perdida` (lista cerrada). Guarda los IDs en `config/hubspot.json` e imprime las líneas `HUBSPOT_PIPELINE_ID` y `HUBSPOT_ETAPA_*` para `.env`. Al final lista los usuarios de HubSpot con su ID.
3. Si el plan lo permite, en HubSpot marca `motivo_perdida` como obligatoria al pasar a "Perdido" (configuración del pipeline, propiedades requeridas por etapa).

✔ Listo cuando el pipeline existe y `.env` tiene los 9 IDs de etapa.

### 2. Postgres

```bash
DATABASE_URL=postgres://... npm run db:migrar
```

Copia `db/vendedores.ejemplo.sql` a `db/vendedores.sql`, pon cada vendedor con su `hubspot_owner_id` (del paso anterior) y su `orden` en la rotación, y córrelo con `psql`.

✔ Listo cuando los vendedores reales están cargados.

### 3. n8n y F1 (recepción)

Si todavía no tienes n8n, instálalo en un servidor siguiendo `deploy/INSTALAR.md`: deja Postgres, n8n y HTTPS funcionando, con la credencial y los flujos ya importados, así que aquí solo te quedan los pasos 4 a 6.

1. En el contenedor de n8n define **todas** las variables de `.env` (n8n las lee con `$env`), incluidas `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` y `N8N_RUNNERS_TASK_TIMEOUT=300`. Reinicia n8n.
2. En n8n crea una credencial de Postgres llamada **Merch Caracas Postgres** que apunte a la base del paso 2.
3. Importa los 5 archivos de `n8n/workflows/` (menú → *Import from file*, o `n8n import:workflow --separate --input=n8n/workflows`). En cada nodo de Postgres elige la credencial. Para no tener que hacerlo a mano, antes de importar reconstruye con el ID de la credencial:
   ```bash
   N8N_POSTGRES_CREDENTIAL_ID=<id de la credencial> npm run n8n:construir
   ```
4. Publica (activa) **F1**. La URL del webhook queda en `https://<tu-n8n>/webhook/merch-caracas/whatsapp`.
5. Apunta 360dialog a esa URL:
   ```bash
   D360_WEBHOOK_URL=https://<tu-n8n>/webhook/merch-caracas/whatsapp npm run webhook:configurar
   ```
   El secreto viaja en el encabezado `X-Webhook-Secret` y también como `?secreto=` en la URL. Si no coincide con `D360_WEBHOOK_SECRET`, la ejecución falla y queda registrada en n8n.
6. Revisa todo con:
   ```bash
   npm run verificar
   ```

✔ Listo cuando un mensaje de prueba crea contacto + negocio con propietario por rotación y la respuesta desde la app completa la tarea "Contestar".

### 4. F2 (Claude) en modo sombra

Con `MODO_SOMBRA=true` (el valor por defecto), publica F2. Durante una semana solo escribe `resumen_ia` y deja en cada negocio una nota con la etapa que detectó, las tareas que habría creado y las reglas que aplicó. Cada análisis queda en la tabla `analisis`.

Para revisar, usa `db/revision_f2.sql`: saca una muestra al azar con la conversación que vio Claude, marca cada caso con `revision_correcta` y calcula la precisión. También muestra errores y el consumo de tokens (el prompt del sistema debe leerse de caché).

✔ Listo cuando la clasificación es correcta en ≥ 90 % de la muestra. Si no llega, ajusta `prompts/clasificador.md` o `ANTHROPIC_EFFORT` (`low` → `medium`), reconstruye e importa F2 de nuevo.

### 5. F3, F4 y F5

Define `HORARIO_LABORAL` (y `FERIADOS` si aplica) y `ADMIN_HUBSPOT_OWNER_ID`, reinicia n8n y publica F3, F4 y F5.

### 6. Activar etapas y tareas reales

Pon `MODO_SOMBRA=false` y reinicia n8n. Desde ahí F2 mueve etapas, escribe los datos del pedido y crea tareas.

## Qué hace cada flujo

| Flujo | Disparador | Qué hace |
|---|---|---|
| **F1** Recepción | Webhook de 360dialog | Guarda los mensajes (sin duplicar). Para un cliente nuevo busca negocio o contacto previo en HubSpot; si había negocio con propietario, reusa ese vendedor; si no, toma el siguiente disponible de la rotación. Crea contacto, negocio en Nuevo y la tarea "Contestar a {nombre}" (15 min laborables). Cuando un vendedor responde desde la app, completa las tareas "Contestar" abiertas. |
| **F2** Análisis | Cada 3 min | Toma los clientes con mensajes nuevos cuyo último mensaje tiene al menos `DEBOUNCE_MIN` minutos, lee el negocio en HubSpot, manda los últimos 40 mensajes a Claude y aplica las reglas (solo avanza, nunca a Pagado, confianza ≥ 0.7, sin tareas duplicadas). |
| **F3** Tiempos | Cada 15 min, solo en horario laboral | Cliente sin respuesta por más del SLA → tarea "Contestar". Tarea "Contestar" vencida hace más de `ESCALAR_MIN` → nota en el negocio y tarea al administrador (una sola vez). |
| **F4** Tareas | Cada 5 min | Revisa en HubSpot las tareas abiertas. Verificar pago → Pagado / En producción + tarea de producción; producción → Listo para enviar + "Enviar pedido"; enviar → Enviado + "Confirmar recepción"; confirmar → Entregado. Solo hacia adelante. |
| **F5** Resumen | 7:30 a. m., días laborables | Cada vendedor recibe una tarea en HubSpot con sus propios pendientes: clientes esperando respuesta, tareas vencidas, tareas de hoy y cotizaciones abiertas (si no tiene nada, no recibe nada). Si hay administrador, recibe además el resumen general: chats sin responder, tareas vencidas por vendedor, cotizaciones abiertas, negocios por etapa y perdidos de las últimas 24 h con motivo. |

## Decisiones de implementación

Cosas que la especificación no fijaba y que resolví así. Todas se pueden cambiar:

1. **Historial (`history`)**: se guardan los mensajes y los clientes, pero no se crean contactos, negocios ni tareas, ni se analiza con Claude. Así la sincronización inicial no llena HubSpot de chats viejos. Si ese cliente vuelve a escribir, se da de alta normalmente.
2. **Conversaciones que inicia un vendedor**: no crean negocio hasta que el cliente responda. Con un número compartido no se puede saber qué vendedor escribió, así que no hay a quién asignarlo sin la rotación.
3. **Cliente que vuelve con negocio cerrado**: F1 crea un negocio nuevo con el mismo propietario. Si el negocio ya existía en Postgres y está en Entregado o Perdido, F2 abre un negocio nuevo cuando Claude detecta un pedido nuevo (etapa Nuevo o Solicitud).
4. **La IA no salta el pago**: si Claude detecta Listo para enviar, Enviado o Entregado y el negocio todavía no pasó por Pagado, se usa Verificar pago.
5. **Tareas que no aplican a la etapa se descartan**, por ejemplo "Enviar pedido" antes del pago o "Enviar cotización" después.
6. **Las reacciones y los mensajes de sistema** no cuentan como mensaje del cliente ni como respuesta.
7. **SLA en minutos laborables**. F3 usa `SLA_RESPUESTA_NUEVO_MIN` si el negocio está en Nuevo y `SLA_RESPUESTA_CURSO_MIN` en las demás etapas. La tarea que crea F3 vence de inmediato, porque el SLA ya se cumplió.
8. **F3 no crea tareas** para negocios perdidos por "No era cliente (spam/equivocado)" o "Duplicado".
9. **Administrador**: variable nueva `ADMIN_HUBSPOT_OWNER_ID`, opcional. Recibe los escalamientos y el resumen general como tareas de HubSpot, que le llegan a la app móvil.
10. **Perdidos "del día"** en F5: negocios en Perdido modificados en las últimas 24 h.
11. **Fechas límite**: "Enviar pedido" vence el día anterior a `fecha_entrega` a las 9:00 (24 h si no hay fecha). "Seguimiento" vence 48 h después del último mensaje de la empresa, que es el envío de la cotización. Las demás siguen la tabla de la especificación en horas corridas.
12. **El propietario en HubSpot manda**: si alguien reasigna un negocio, el sistema toma el nuevo propietario para las tareas siguientes.
13. **Notas de F2**: en modo sombra, una nota en cada análisis. En modo activo, solo cuando cambia la etapa o se crean tareas.
14. **Datos del pedido**: solo se escriben valores que Claude encontró. Un `null` nunca borra un dato existente.
15. **Fallos de F2**: se reintenta a los 15 min. Tras 5 fallos seguidos deja de intentar con ese cliente hasta que llegue un mensaje nuevo, y aparece como alerta en el resumen diario.
16. **Motivo de pérdida**: propiedad nueva `motivo_perdida` de tipo lista, porque la propiedad nativa de HubSpot es texto libre.
17. **Probabilidad por etapa** (HubSpot la exige): 10, 20, 40, 70, 90, 90, 95, 100 y 0 %. Se ajusta en HubSpot sin tocar el código.
18. **Claude**: `ANTHROPIC_MODEL` con salidas estructuradas (esquema JSON del contrato), caché del prompt del sistema, esfuerzo `low` (ajustable con `ANTHROPIC_EFFORT`) y reintento del lado del servidor con otro modelo si el principal rechaza la solicitud (`ANTHROPIC_FALLBACK=default`; `no` lo apaga). Si el JSON no cumple el contrato, se reintenta una vez.
19. **Resumen diario por vendedor** (pedido de Oscar): además del resumen general, cada vendedor recibe el suyo con sus pendientes. Solo se manda en días con horario laboral.
20. **Responsable de producción** (pedido de Oscar): variable nueva `PRODUCCION_HUBSPOT_OWNER_ID`, opcional. Si está definida, todas las tareas "Iniciar producción" van a esa persona y el negocio sigue a nombre del vendedor. Al completarla, "Enviar pedido" vuelve al vendedor. Cada tarea guarda su propietario, y el resumen diario se la muestra a quien la tiene.

## Limitaciones conocidas

- **Claude no ve imágenes ni escucha notas de voz.** Recibe `[imagen]`, `[nota de voz o audio]` o el nombre del documento, junto con el texto que los acompañe. Un comprobante se detecta por el contexto ("listo, ahí va el pago" + imagen). Descargar los archivos desde 360dialog y mandárselos a Claude es una mejora posible.
- **No se sabe qué vendedor escribió cada mensaje**, porque todos usan el mismo número.
- **La búsqueda de HubSpot tarda unos segundos en indexar** registros nuevos. Postgres tiene un candado para que dos mensajes seguidos del mismo cliente no creen dos negocios.

## Pendiente de definir por Oscar

De la especificación:

- Horario laboral (días y horas) → `HORARIO_LABORAL`. Mientras no esté definido, F1 guarda los mensajes pero no da de alta clientes nuevos y F3 no corre. El error lo dice claramente y no se usa ningún valor inventado.
- Lista de vendedores y su orden en la rotación → tabla `vendedores`.
- Plan de HubSpot y número de asientos.
- Si el plan permite que el motivo de pérdida sea obligatorio al pasar a Perdido.
- Con 360dialog: cuántos dispositivos vinculados admite el número en coexistencia y confirmar que llegan los `smb_message_echoes`. Sin ellos no se completan solas las tareas "Contestar", y F3 crea tareas de más.
- Si la aprobación de arte va como etapa separada del pipeline.

Surgieron de la implementación:

- Quién es el administrador en HubSpot → `ADMIN_HUBSPOT_OWNER_ID`.
- **Cliente que vuelve cuando su vendedor tiene `disponible = false`**: hoy va al mismo vendedor, tal como dice la especificación. ¿Debería pasar a la rotación?
- ¿Los chats del historial inicial deben crear negocios? Hoy no (ver decisión 1).

## Desarrollo

```bash
npm test                                   # pruebas unitarias y de flujos
TEST_DATABASE_URL=postgres://... npm test  # suma las pruebas contra Postgres (esquema "prueba" y una base temporal para Supabase)
node supabase/construir.js                 # regenera supabase/instalar.sql y la función después de cambiar src/ o el prompt
npm run n8n:construir                      # regenera n8n/workflows/
```

Hay pruebas que fallan si `supabase/` o `n8n/workflows/` no están al día con `src/`.
