#!/usr/bin/env bash
# Instala todo en un servidor Ubuntu nuevo con un solo comando (como root):
#
#   curl -fsSL https://raw.githubusercontent.com/juandnr/OscarB2B/claude/merch-caracas-whatsapp-ai-12autr/merch-caracas/deploy/instalar-servidor.sh | bash -s -- n8n.tudominio.com
#
# Sin dominio (termina en "bash"), usa una dirección automática de sslip.io
# armada con la IP del servidor, por ejemplo 203-0-113-7.sslip.io.
#
# Hace: Docker, firewall, descarga del código en /opt/merch, .env con claves
# aleatorias, Postgres + n8n + HTTPS, tablas del sistema, credencial y flujos.
# Se puede volver a correr: no pisa .env ni duplica nada.
set -euo pipefail

REPO=${REPO:-https://github.com/juandnr/OscarB2B.git}
RAMA=${RAMA:-claude/merch-caracas-whatsapp-ai-12autr}
DIR=${DIR:-/opt/merch}

paso() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
falla() { printf '\n\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

# Todo va dentro de main: con "curl | bash", bash lee el script completo antes
# de ejecutarlo y ningún comando se "come" el resto del script por la entrada.
main() {
DOMINIO=${1:-}

[ "$(id -u)" -eq 0 ] || falla "Corre el comando como root (o con sudo)."
command -v apt-get >/dev/null || falla "Este instalador es para Ubuntu o Debian."

ip_servidor=$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
DOMINIO=${DOMINIO#https://}
DOMINIO=${DOMINIO%%/*}
if [ -z "$DOMINIO" ]; then
  [ -n "$ip_servidor" ] || falla "No pude averiguar la IP del servidor. Pasa un dominio: ... | bash -s -- n8n.tudominio.com"
  DOMINIO="${ip_servidor//./-}.sslip.io"
  echo "Sin dominio propio: se usa $DOMINIO"
fi

paso "Revisando que $DOMINIO apunte a este servidor"
ip_dominio=$(getent ahostsv4 "$DOMINIO" | awk 'NR==1 {print $1}' || true)
if [ -z "$ip_dominio" ]; then
  echo "! $DOMINIO todavía no resuelve. Crea el registro A hacia ${ip_servidor:-la IP del servidor}."
  echo "  Sigo igual: el certificado HTTPS se pedirá solo cuando el DNS esté listo."
elif [ -n "$ip_servidor" ] && [ "$ip_dominio" != "$ip_servidor" ]; then
  echo "! $DOMINIO apunta a $ip_dominio, pero este servidor es $ip_servidor."
  echo "  Corrige el registro A; mientras tanto no habrá certificado HTTPS."
else
  echo "✔ $DOMINIO → $ip_dominio"
fi

paso "Instalando Docker y git"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
else
  echo "✔ Docker ya está instalado"
fi
command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git; }
command -v openssl >/dev/null || { apt-get update -qq && apt-get install -y -qq openssl; }

paso "Firewall: SSH, 80 y 443"
if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  echo "✔ ufw activo"
else
  echo "! ufw no está instalado: abre los puertos 80 y 443 en el panel del proveedor."
fi

paso "Descargando el código en $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$RAMA"
  git -C "$DIR" checkout -q "$RAMA"
  git -C "$DIR" pull -q --ff-only origin "$RAMA"
else
  git clone -q --branch "$RAMA" "$REPO" "$DIR"
fi
cd "$DIR/merch-caracas"
echo "✔ $(git log -1 --format='%h %s')"

paso "Preparando .env"
N8N_DOMINIO=$DOMINIO ./deploy/preparar.sh </dev/null

paso "Arrancando Postgres, n8n y Caddy"
docker compose up -d </dev/null

paso "Esperando a que n8n esté listo"
for _ in $(seq 1 90); do
  if docker compose exec -T n8n wget -qO- http://localhost:5678/healthz </dev/null >/dev/null 2>&1; then
    listo=1
    break
  fi
  sleep 2
done
[ "${listo:-0}" = 1 ] || falla "n8n no respondió en 3 minutos. Revisa: docker compose logs n8n"
echo "✔ n8n responde"

paso "Creando las tablas del sistema"
docker compose run --rm -T herramientas sh -c "npm ci --omit=dev --no-audit --no-fund && npm run db:migrar" </dev/null

paso "Importando la credencial y los flujos"
./deploy/importar-flujos.sh </dev/null

cat <<EOF

$(printf '\033[1m✔ Instalación lista\033[0m')

  1. Abre YA https://$DOMINIO y crea la cuenta de propietario de n8n
     (la primera persona que entre se queda con ella).
  2. Guarda una copia de $DIR/merch-caracas/.env en un lugar seguro.
  3. Los 5 flujos están importados pero sin publicar: falta completar
     HubSpot, Claude y el horario en .env (ver deploy/INSTALAR.md).

EOF
}

main "$@"
