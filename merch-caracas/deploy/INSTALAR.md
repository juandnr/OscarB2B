# Instalar n8n en un servidor

Deja funcionando en un servidor propio: Postgres, n8n 2.41.3 y HTTPS automático, con la credencial y los 5 flujos ya importados. Se hace una sola vez y toma cerca de media hora.

## Opción rápida: un solo comando

En un servidor Ubuntu nuevo, abre la consola (por SSH o la consola web del proveedor) y pega:

```bash
curl -fsSL https://raw.githubusercontent.com/juandnr/OscarB2B/claude/merch-caracas-whatsapp-ai-12autr/merch-caracas/deploy/instalar-servidor.sh | bash -s -- n8n.tudominio.com
```

Hace los pasos 2 a 7 de abajo por ti. Si todavía no tienes subdominio, borra `-s -- n8n.tudominio.com` y el comando termina en `| bash`: n8n queda en una dirección automática, como `203-0-113-7.sslip.io`, que sirve para empezar. Más adelante conviene pasarlo a un subdominio propio, porque si cambia la IP del servidor cambia la dirección y hay que reconfigurar el webhook de 360dialog.

Al terminar, abre de inmediato la dirección que imprime y crea la cuenta de propietario de n8n.

## Qué necesitas antes de empezar

- **Un servidor (VPS) con Ubuntu 24.04**, de al menos 2 vCPU, 4 GB de RAM y 40 GB de disco. Sirve cualquier proveedor: Hetzner, DigitalOcean, Hostinger, Vultr…
- **Un subdominio para n8n**, por ejemplo `n8n.merchcaracas.com`. En el panel de tu dominio crea un registro **A** que apunte a la IP del servidor. Tiene que estar funcionando **antes** del paso 5, porque el certificado HTTPS se pide con ese nombre.
- Acceso por **SSH** al servidor, con el usuario `root` o uno con `sudo`.

## Pasos

Todos los comandos se escriben en el servidor.

**1. Entrar al servidor**

```bash
ssh root@IP_DEL_SERVIDOR
```

**2. Instalar Docker y abrir el firewall**

```bash
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

Respeta el orden del segundo comando: primero se permite SSH y después se activa el firewall, para no quedarte fuera del servidor.

**3. Bajar el código**

```bash
git clone --branch claude/merch-caracas-whatsapp-ai-12autr https://github.com/juandnr/OscarB2B.git
cd OscarB2B/merch-caracas
```

Cuando el proyecto pase a su propio repositorio privado, este comando cambia.

**4. Preparar la configuración**

```bash
./deploy/preparar.sh
```

Te pide el subdominio y crea `.env` con estas claves aleatorias: contraseña de Postgres, clave de cifrado de n8n y secreto del webhook. **Guarda una copia de `.env`** en un gestor de contraseñas: si se pierde `N8N_ENCRYPTION_KEY`, n8n ya no puede leer sus credenciales.

**5. Arrancar**

```bash
docker compose up -d
```

Espera uno o dos minutos y abre `https://TU_SUBDOMINIO` en el navegador. **Crea la cuenta de propietario de n8n de inmediato**: la primera persona que entre se queda con ella. Usa una contraseña fuerte y activa la verificación en dos pasos en la configuración de n8n.

**6. Crear las tablas del sistema**

```bash
docker compose run --rm herramientas sh -c "npm ci --omit=dev && npm run db:migrar"
```

**7. Importar la credencial y los flujos**

```bash
./deploy/importar-flujos.sh
```

En n8n vas a ver los 5 flujos (F1 a F5). La credencial "Merch Caracas Postgres" ya queda enlazada en todos los nodos. **No los publiques todavía**: primero falta completar HubSpot, Claude y el horario.

**8. Revisar**

```bash
docker compose run --rm herramientas npm run verificar
```

Por ahora va a marcar lo que todavía no está: tokens de HubSpot y Claude, horario laboral, vendedores. Es normal.

## Cuando tengas los datos que faltan

1. Completa `.env` con `nano .env`: token de HubSpot, API key de Anthropic, `HORARIO_LABORAL`, `ADMIN_HUBSPOT_OWNER_ID`, `D360_API_KEY`.
2. Configura HubSpot desde el servidor:
   ```bash
   docker compose run --rm herramientas npm run hubspot:setup
   ```
   Copia en `.env` los IDs que imprime.
3. Carga los vendedores (ver `db/vendedores.ejemplo.sql`):
   ```bash
   docker compose exec -T postgres psql -U merch -d merch < db/vendedores.sql
   ```
4. Reinicia n8n para que lea el `.env` nuevo:
   ```bash
   docker compose up -d --force-recreate n8n
   ```
5. Sigue con el paso 3 del `README.md`: publicar F1, conectar el webhook de 360dialog y hacer la prueba.

## Mantenimiento

| Para | Comando |
|---|---|
| Ver qué está pasando en n8n | `docker compose logs -f n8n` |
| Reiniciar n8n | `docker compose restart n8n` |
| Aplicar cambios de `.env` | `docker compose up -d --force-recreate n8n` |
| Actualizar el código y los flujos | `git pull && ./deploy/importar-flujos.sh`, y revisa en n8n que los flujos sigan publicados |
| Respaldar las bases de datos | `docker compose exec -T postgres pg_dumpall -U merch \| gzip > respaldo-$(date +%F).sql.gz` |

Guarda los respaldos fuera del servidor. Si el proveedor ofrece copias automáticas (snapshots), actívalas.
