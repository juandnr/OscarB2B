# Conectar el Gmail de la empresa

Un pequeño script de Google, guardado en la misma cuenta de Gmail, revisa el correo cada 5 minutos y le manda al sistema los correos nuevos:

- los **recibidos**, menos Promociones, Social, Notificaciones, Foros y Spam;
- los **enviados**.

En el sistema pasa esto:

1. Los correos automáticos o masivos se descartan (boletines, no-reply, los que traen enlace para darse de baja).
2. Del resto, **Claude decide cuáles son de clientes**.
3. Por cada cliente nuevo se crea en HubSpot el contacto (con su email) y el negocio en el pipeline **Ventas**, con canal **Correo**.
4. El negocio se asigna por turnos y se crea la tarea "Contestar".
5. Cuando se le responde desde este Gmail, la tarea se completa sola.

El script **solo lee** el correo: no borra, no envía y no cambia nada.

**Archivos que vas a copiar:**

- Código: <https://raw.githubusercontent.com/juandnr/OscarB2B/claude/merch-caracas-whatsapp-ai-12autr/merch-caracas/gmail/Codigo.gs>
- Permisos: <https://raw.githubusercontent.com/juandnr/OscarB2B/claude/merch-caracas-whatsapp-ai-12autr/merch-caracas/gmail/appsscript.json>

## 1. Copiar el secreto

En Supabase, **SQL Editor** → **New query** → **Run**:

```sql
select decrypted_secret from vault.decrypted_secrets where name = 'merch_correo_secreto';
```

Copia ese texto. No lo compartas con nadie: es la llave para mandarle correos al sistema.

## 2. Crear el script

1. Entra en <https://script.google.com> **con la cuenta de Gmail de la empresa** (la que recibe los correos de los clientes).
2. Pulsa **Nuevo proyecto**. Arriba, donde dice "Proyecto sin título", ponle de nombre `Merch Caracas correo`.
3. Pulsa el engranaje **⚙ Configuración del proyecto** (a la izquierda) y marca **Mostrar el archivo de manifiesto "appsscript.json" en el editor**.
4. Vuelve al editor (el ícono **< >** a la izquierda). Ahora hay dos archivos:
   - **appsscript.json**: ábrelo, borra todo y pega el contenido del enlace "Permisos".
   - **Código.gs**: ábrelo, borra todo y pega el contenido del enlace "Código".
5. En **Código.gs**, al principio, llena las dos líneas:
   - `URL_FUNCION`: la dirección de tu función, por ejemplo `'https://euxcmxjamzhjfrdjajow.supabase.co/functions/v1/merch'`.
   - `SECRETO`: el texto del paso 1, entre comillas simples.
6. Guarda con **Ctrl + S**.

## 3. Ponerlo a andar

1. Arriba, en la lista de funciones, elige **instalar** y pulsa **Ejecutar**.
2. Google te pide permiso:
   1. Pulsa **Revisar permisos** y elige la cuenta de la empresa.
   2. Va a salir "Google no verificó esta app". Es normal, porque es tu propio script. Pulsa **Configuración avanzada** → **Ir a Merch Caracas correo (no seguro)**.
   3. Pulsa **Permitir**. Los permisos son: ver tus correos (solo leer), conectarse a un servicio externo (tu función de Supabase) y ejecutarse solo cada 5 minutos.
3. Abajo, en el registro, tiene que salir **"Listo: el correo se revisa cada 5 minutos"**.

La primera vez solo manda los correos de la última hora: no manda el historial.

## 4. Revisar y encender

En Supabase, en el SQL Editor, mira qué está llegando:

```sql
select fecha, direccion, de_email, asunto, estado, motivo from merch.correos order by fecha desc limit 30;
```

Los correos aparecen como `pendiente`. Cuando veas que llegan, enciende el análisis:

```sql
update merch.configuracion set valor = 'true' where clave = 'F6_ACTIVO';
```

Desde la siguiente revisión cada correo queda en uno de estos estados:

| Estado | Qué significa |
|---|---|
| `cliente` | Se registró: creó el negocio o se sumó al cliente que ya existía |
| `no_cliente` | Claude decidió que no es un cliente; en `motivo` dice por qué |
| `ignorado` | Correo automático o masivo, o un correo enviado a alguien que no es cliente |

Si un remitente que nunca es cliente se cuela (un proveedor, un banco), agrégalo en `merch.configuracion`, clave `CORREO_IGNORAR`. Puedes poner emails o dominios separados por coma, por ejemplo `banco.com, aviso@tienda.com`.

Si un cliente quedó como `no_cliente` por error, el vendedor crea a mano en HubSpot el contacto (con ese email) y su negocio en el pipeline **Ventas**. Desde el siguiente correo, el sistema lo reconoce como cliente. Además, cualquier remitente cuyo contacto ya tenga un negocio en HubSpot cuenta como cliente sin preguntarle a Claude, por ejemplo un cliente de WhatsApp que también escribe por correo.

## Si algo falla

- El script le avisa por correo a la cuenta de Gmail cuando una ejecución falla. También puedes verlo en script.google.com → **Ejecuciones**.
- `La función respondió 401`: el `SECRETO` está mal copiado.
- `La función respondió 404`: revisa la `URL_FUNCION`, que debe terminar en `/functions/v1/merch`.
- Para apagarlo: en el script elige la función **desinstalar** y pulsa **Ejecutar**.
