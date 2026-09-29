#!/usr/bin/env bash
# Crea .env a partir de .env.example y llena lo que se puede generar solo:
# dominio de n8n, contraseña de Postgres, clave de cifrado de n8n, secreto del
# webhook y las URL que dependen de ellos. Nunca pisa un valor que ya exista.
#
# Uso (en la carpeta merch-caracas):   ./deploy/preparar.sh
#      o sin preguntas:                N8N_DOMINIO=n8n.midominio.com ./deploy/preparar.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "✔ Creado .env a partir de .env.example"
fi

valor() {
  grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true
}

# Pone clave=valor solo si la clave está vacía o no existe.
poner() {
  local clave=$1 nuevo=$2
  if [ -n "$(valor "$clave")" ]; then
    echo "• $clave ya tiene valor: no se toca"
    return
  fi
  if grep -qE "^$clave=" .env; then
    sed -i "s|^$clave=.*|$clave=$nuevo|" .env
  else
    printf '%s=%s\n' "$clave" "$nuevo" >> .env
  fi
  echo "✔ $clave"
}

aleatorio() {
  openssl rand -hex "$1"
}

dominio=$(valor N8N_DOMINIO)
if [ -z "$dominio" ]; then
  dominio=${N8N_DOMINIO:-}
  while [ -z "$dominio" ]; do
    read -rp "Dominio para n8n (ej. n8n.merchcaracas.com): " dominio
  done
fi
dominio=${dominio#https://}
dominio=${dominio%%/*}

poner N8N_DOMINIO "$dominio"
poner POSTGRES_USER merch
poner POSTGRES_PASSWORD "$(aleatorio 24)"
poner N8N_ENCRYPTION_KEY "$(aleatorio 32)"
poner D360_WEBHOOK_SECRET "$(aleatorio 24)"
poner D360_WEBHOOK_URL "https://$dominio/webhook/merch-caracas/whatsapp"
poner DATABASE_URL "postgresql://$(valor POSTGRES_USER):$(valor POSTGRES_PASSWORD)@postgres:5432/merch"

echo
echo "Listo. Guarda una copia de .env en un lugar seguro: sin N8N_ENCRYPTION_KEY"
echo "n8n no puede leer las credenciales guardadas."
