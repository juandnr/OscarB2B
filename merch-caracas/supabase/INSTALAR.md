# Instalar en Supabase (sin servidor)

Todo corre gratis dentro de un proyecto de Supabase:

- **Base de datos:** la del proyecto, en el esquema `merch`.
- **Los cinco flujos:** una sola Edge Function llamada `merch`.
- **Tareas programadas:** el cron de Supabase llama a esa función cada pocos minutos.

No hace falta instalar nada en tu computadora. Todo se hace desde el panel de Supabase copiando y pegando.

**Archivos que vas a copiar** (ábrelos, selecciona todo y copia):

- SQL: <https://raw.githubusercontent.com/juandnr/OscarB2B/claude/merch-caracas-whatsapp-ai-12autr/merch-caracas/supabase/instalar.sql>
- Función: <https://raw.githubusercontent.com/juandnr/OscarB2B/claude/merch-caracas-whatsapp-ai-12autr/merch-caracas/supabase/functions/merch/index.ts>

## 1. Crear el proyecto

En supabase.com crea un proyecto nuevo llamado `merch-caracas`, en el plan gratis. No uses el proyecto de tu web. Guarda la contraseña de la base que te pide. Espera a que termine de crearse (un par de minutos).

## 2. Crear las tablas

1. Menú **SQL Editor** → **New query**.
2. Pega todo el contenido de `instalar.sql` y pulsa **Run**.
3. Al final debe salir **Instalación lista** con `migraciones = 2`.

Crea las tablas y las funciones del esquema `merch`, la tabla de configuración y las tareas programadas del cron. Se puede volver a correr cuando haya una versión nueva: no borra nada.

Si sale un error de permisos con `pg_cron` o `pg_net`, actívalos en **Database → Extensions** y vuelve a correr el SQL.

## 3. Crear la función

1. Menú **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Nombre: `merch` (tiene que ser exactamente ese).
3. Borra el código de ejemplo, pega todo el contenido de `index.ts` y pulsa **Deploy**.
4. En los detalles de la función, **apaga "Verify JWT"**, que en el panel puede aparecer como "Enforce JWT verification", y guarda. Si queda encendido, 360dialog y el cron reciben error 401.

   Supabase a veces vuelve a encender este interruptor al actualizar la función: **revísalo cada vez que pegues una versión nueva.**

## 4. Cargar las claves

En **Edge Functions → Secrets** agrega las que ya tengas; las demás, cuando las consigas:

| Nombre | Qué es |
|---|---|
| `HUBSPOT_PRIVATE_APP_TOKEN` | Token de la app privada de HubSpot |
| `ANTHROPIC_API_KEY` | API key de Claude (console.anthropic.com) |
| `D360_API_KEY` | API key de 360dialog |

Solo van estas tres. El resto de la configuración está en una tabla que se edita en el paso 6.

## 5. Revisar

Abre en el navegador (el ID del proyecto está en **Project Settings**):

```
https://TU-PROYECTO.supabase.co/functions/v1/merch/salud
```

Muestra la URL de la función y, para cada flujo, qué datos faltan. La primera vez que abres esta página, la función se registra para que el cron sepa a dónde llamar. **No te saltes este paso.**

## 6. Configurar

**HubSpot.** Con el token ya cargado, en el SQL Editor corre:

```sql
select merch.llamar('hubspot-setup');
```

Espera unos 30 segundos y mira el resultado:

```sql
select ok, detalle from merch.bitacora where ruta = 'hubspot-setup' order by id desc limit 1;
```

Esto crea en HubSpot el pipeline "WhatsApp Ventas" con sus etapas y propiedades, y guarda solos los IDs. En `detalle` → `usuarios` aparecen los usuarios de HubSpot con su `hubspot_owner_id`.

**Vendedores.** Menú **Table Editor**, esquema **merch**, tabla `vendedores` → **Insert row**. Llena `nombre`, `hubspot_owner_id` y `orden` (posición en la rotación). Para sacar a alguien de la rotación sin borrarlo, pon `disponible` en false.

**Configuración.** Tabla `configuracion` del mismo esquema. Cada fila tiene su descripción. Lo mínimo:

- `HORARIO_LABORAL`, por ejemplo `lun-vie 08:00-17:00; sab 08:00-12:00`.
- `ADMIN_HUBSPOT_OWNER_ID`, la persona que recibe escalamientos y el resumen diario.

## 7. Conectar WhatsApp

Cuando 360dialog tenga activa la coexistencia de tu número y `D360_API_KEY` esté cargada:

```sql
select merch.llamar('configurar-webhook');
```

Revisa el resultado con la consulta de la bitácora, cambiando la ruta por `configurar-webhook`. Desde ese momento cada mensaje llega a la función y se registra. La prueba: escribe al WhatsApp desde otro teléfono. Debe aparecer contacto, negocio y la tarea "Contestar" en HubSpot, y al responder desde la app la tarea se completa sola.

## 8. Encender los flujos

En la tabla `configuracion`:

1. **`F2_ACTIVO` = `true`.** Claude analiza los chats en **modo sombra**: solo escribe `resumen_ia` y una nota. Déjalo así una semana y revisa la precisión con `db/revision_f2.sql`. Antes de esas consultas corre `set search_path = merch;` en el SQL Editor.
2. **`F3_ACTIVO`, `F4_ACTIVO` y `F5_ACTIVO` = `true`.** Tiempos de respuesta, tareas completadas y resumen diario.
3. **`MODO_SOMBRA` = `false`.** Claude empieza a mover etapas y crear tareas.

Los cambios en `configuracion` se aplican en la siguiente corrida, sin tocar la función.

## Día a día

- **Qué está pasando:**
  ```sql
  select creado_at, ruta, ok, detalle from merch.bitacora order by id desc limit 20;
  ```
  Los errores quedan con `ok = false`. También están los registros en **Edge Functions → merch → Logs**.
- **Actualizar** cuando haya una versión nueva:
  1. Vuelve a correr `instalar.sql`.
  2. Pega el `index.ts` nuevo en la función.
  3. Revisa que "Verify JWT" siga apagado.
- **Plan gratis:**
  - Supabase pausa los proyectos gratis que pasan 7 días sin actividad. Con el cron cada pocos minutos no debería pasar. Si igual se pausa, en el panel aparece el botón para reactivarlo, y mientras tanto no se registran mensajes.
  - Cada ejecución de la función tiene un máximo de 150 segundos. F2 analiza hasta 80 segundos por corrida y deja el resto para la siguiente.
