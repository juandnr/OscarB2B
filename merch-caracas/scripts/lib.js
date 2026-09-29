'use strict';

// Utilidades para los scripts de línea de comandos (no se empaquetan en n8n).

const fs = require('fs');
const path = require('path');

// Carga merch-caracas/.env sin pisar variables ya definidas en el entorno.
function cargarEnv(archivo = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(archivo)) return;
  for (const linea of fs.readFileSync(archivo, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/.exec(linea);
    if (!m || linea.trim().startsWith('#')) continue;
    let valor = (m[2] || '').trim();
    if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
      valor = valor.slice(1, -1);
    } else {
      valor = valor.replace(/\s+#.*$/, '');
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = valor;
  }
}

// Implementación de la función http de los módulos de src/ con fetch.
async function http({ method, url, headers, body, timeout }) {
  const r = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout || 30000),
  });
  const texto = await r.text();
  let json = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch (error) {
    json = texto;
  }
  return { status: r.status, body: json, headers: Object.fromEntries(r.headers) };
}

module.exports = { cargarEnv, http };
