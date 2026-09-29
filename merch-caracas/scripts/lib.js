'use strict';

// Utilidades para los scripts de línea de comandos (no se empaquetan en n8n).

const fs = require('fs');
const path = require('path');
const { crearHttp } = require('../src/http');

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
const http = crearHttp();

module.exports = { cargarEnv, http };
