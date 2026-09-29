#!/usr/bin/env bash
# Importa en n8n (que ya debe estar corriendo con docker compose) la credencial
# de Postgres y los 5 flujos. Se puede repetir: actualiza en vez de duplicar.
# Después de importar, publica (activa) los flujos desde n8n.
#
# Uso (en la carpeta merch-caracas):   ./deploy/importar-flujos.sh
set -euo pipefail
cd "$(dirname "$0")/.."

valor() {
  grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true
}

usuario=$(valor POSTGRES_USER)
clave=$(valor POSTGRES_PASSWORD)
if [ -z "$clave" ]; then
  echo "✘ Falta POSTGRES_PASSWORD en .env (corre ./deploy/preparar.sh)" >&2
  exit 1
fi

# La credencial usa el mismo ID que traen los nodos de Postgres de los flujos,
# así quedan enlazados sin elegirla a mano en cada nodo.
docker compose exec -T n8n sh -c 'umask 077 && cat > /tmp/credencial.json' <<EOF
[{"id": "merch-caracas-postgres", "name": "Merch Caracas Postgres", "type": "postgres",
  "data": {"host": "postgres", "port": 5432, "database": "merch", "user": "${usuario:-merch}",
           "password": "$clave", "ssl": "disable", "allowUnauthorizedCerts": false}}]
EOF
docker compose exec -T n8n n8n import:credentials --input=/tmp/credencial.json
docker compose exec -T n8n rm -f /tmp/credencial.json

docker compose exec -T n8n n8n import:workflow --separate --input=/flujos

echo
echo "✔ Credencial y flujos importados. Entra a n8n y publica los flujos que toquen."
