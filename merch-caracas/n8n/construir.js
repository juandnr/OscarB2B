#!/usr/bin/env node
'use strict';

// Genera los flujos de n8n (n8n/workflows/*.json) a partir de src/.
//
// Cada Code node lleva empaquetados los módulos de src/ que necesita, así la
// lógica se prueba con `npm test` y n8n ejecuta exactamente el mismo código.
//
// Uso:
//   node n8n/construir.js
//   N8N_POSTGRES_CREDENTIAL_ID=abc123 node n8n/construir.js   (enlaza la credencial al importar)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { empaquetar } = require('../scripts/empaquetar');

const RAIZ = path.join(__dirname, '..');
const SALIDA = path.join(__dirname, 'workflows');
const ZONA = process.env.TIMEZONE || 'America/Caracas';
const CREDENCIAL_PG = {
  postgres: {
    id: process.env.N8N_POSTGRES_CREDENTIAL_ID || 'merch-caracas-postgres',
    name: process.env.N8N_POSTGRES_CREDENTIAL_NAME || 'Merch Caracas Postgres',
  },
};

// Código completo de un Code node que llama a `funcion` de `modulo`.
function codigoNodo({ flujo, nombre, modulo, funcion, extra }) {
  return [
    `// Merch Caracas · ${flujo} · ${nombre}`,
    '// Generado por n8n/construir.js desde src/. No lo edites aquí: cambia src/,',
    '// corre `npm run n8n:construir` y vuelve a importar el flujo.',
    '',
    empaquetar(modulo),
    '',
    "const __h = (typeof helpers !== 'undefined' && helpers) || (this && this.helpers);",
    'const __ctx = {',
    '  env: $env,',
    '  http: async (o) => {',
    '    const r = await __h.httpRequest({',
    '      method: o.method, url: o.url, headers: o.headers, body: o.body, json: true,',
    '      returnFullResponse: true, ignoreHttpStatusErrors: true, timeout: o.timeout || 30000,',
    '    });',
    '    return { status: r.statusCode, body: r.body, headers: r.headers || {} };',
    '  },',
    '  ahora: () => new Date(),',
    '  esperar: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),',
    '};',
    `const __extra = ${extra || '{}'};`,
    `const __salida = await __cargar(${JSON.stringify(modulo)}).${funcion}($input.all().map((i) => i.json), __ctx, __extra);`,
    'return __salida.map((json) => ({ json }));',
    '',
  ].join('\n');
}

// ── Nodos ───────────────────────────────────────────────────────────────────

function uuid(semilla) {
  const h = crypto.createHash('sha256').update(semilla).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function nodo(flujo, def) {
  const base = { id: uuid(`${flujo}/${def.nombre}`), name: def.nombre, position: def.pos };
  switch (def.tipo) {
    case 'webhook':
      return {
        ...base,
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        webhookId: uuid(`${flujo}/${def.nombre}/webhook`),
        parameters: { httpMethod: 'POST', path: def.ruta, responseMode: 'onReceived', options: {} },
      };
    case 'cron':
      return {
        ...base,
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        parameters: { rule: { interval: [{ field: 'cronExpression', expression: def.cron }] } },
      };
    case 'code':
      return {
        ...base,
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        parameters: { jsCode: codigoNodo({ flujo, ...def }) },
      };
    case 'postgres':
      return {
        ...base,
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.6,
        credentials: CREDENCIAL_PG,
        parameters: {
          operation: 'executeQuery',
          query: def.sql,
          options: def.parametros ? { queryReplacement: def.parametros } : {},
        },
      };
    default:
      throw new Error(`Tipo de nodo desconocido: ${def.tipo}`);
  }
}

const jsonParam = (campo) => `={{ [ JSON.stringify($json.${campo}) ] }}`;

const FLUJOS = [
  {
    archivo: 'F1-recepcion.json',
    clave: 'F1',
    nombre: 'Merch Caracas · F1 Recepción WhatsApp',
    nodos: [
      { nombre: 'Webhook 360dialog', tipo: 'webhook', ruta: 'merch-caracas/whatsapp', pos: [0, 0] },
      { nombre: 'Normalizar mensajes', tipo: 'code', modulo: 'src/flujos/f1.js', funcion: 'normalizar', pos: [220, 0] },
      { nombre: 'Registrar mensajes', tipo: 'postgres', sql: 'select * from f1_registrar_mensajes($1::jsonb)', parametros: jsonParam('mensajes'), pos: [440, 0] },
      { nombre: 'Buscar en HubSpot', tipo: 'code', modulo: 'src/flujos/f1.js', funcion: 'buscarEnHubspot', pos: [660, -120] },
      { nombre: 'Asignar vendedor', tipo: 'postgres', sql: 'select * from f1_asignar_vendedor($1::jsonb)', parametros: jsonParam('asignaciones'), pos: [880, -120] },
      {
        nombre: 'Crear en HubSpot', tipo: 'code', modulo: 'src/flujos/f1.js', funcion: 'crearEnHubspot', pos: [1100, -120],
        extra: "{ busquedas: $('Buscar en HubSpot').first().json.busquedas }",
      },
      { nombre: 'Guardar alta', tipo: 'postgres', sql: 'select registrar_cambios($1::jsonb) as resultado', parametros: jsonParam('cambios'), pos: [1320, -120] },
      { nombre: 'Completar respondidas', tipo: 'code', modulo: 'src/flujos/f1.js', funcion: 'completarRespondidas', pos: [660, 120] },
      { nombre: 'Guardar respondidas', tipo: 'postgres', sql: 'select registrar_cambios($1::jsonb) as resultado', parametros: jsonParam('cambios'), pos: [880, 120] },
    ],
    conexiones: [
      ['Webhook 360dialog', 'Normalizar mensajes'],
      ['Normalizar mensajes', 'Registrar mensajes'],
      ['Registrar mensajes', 'Buscar en HubSpot'],
      ['Registrar mensajes', 'Completar respondidas'],
      ['Buscar en HubSpot', 'Asignar vendedor'],
      ['Asignar vendedor', 'Crear en HubSpot'],
      ['Crear en HubSpot', 'Guardar alta'],
      ['Completar respondidas', 'Guardar respondidas'],
    ],
  },
  {
    archivo: 'F2-analisis-claude.json',
    clave: 'F2',
    nombre: 'Merch Caracas · F2 Análisis con Claude',
    nodos: [
      { nombre: 'Cada 3 minutos', tipo: 'cron', cron: '*/3 * * * *', pos: [0, 0] },
      {
        nombre: 'Tomar pendientes', tipo: 'postgres', pos: [220, 0],
        sql: 'select * from f2_tomar_pendientes($1, $2)',
        parametros: '={{ [ Number($env.DEBOUNCE_MIN || 5), Number($env.F2_LOTE || 8) ] }}',
      },
      { nombre: 'Analizar con Claude', tipo: 'code', modulo: 'src/flujos/f2.js', funcion: 'analizar', pos: [440, 0] },
      { nombre: 'Guardar resultados', tipo: 'postgres', sql: 'select f2_guardar_resultados($1::jsonb) as resultado', parametros: jsonParam('resultados'), pos: [660, 0] },
    ],
    conexiones: [
      ['Cada 3 minutos', 'Tomar pendientes'],
      ['Tomar pendientes', 'Analizar con Claude'],
      ['Analizar con Claude', 'Guardar resultados'],
    ],
  },
  {
    archivo: 'F3-tiempos-respuesta.json',
    clave: 'F3',
    nombre: 'Merch Caracas · F3 Tiempos de respuesta',
    nodos: [
      { nombre: 'Cada 15 minutos', tipo: 'cron', cron: '*/15 * * * *', pos: [0, 0] },
      { nombre: 'Estado de respuestas', tipo: 'postgres', sql: 'select * from f3_estado()', pos: [220, 0] },
      { nombre: 'Revisar SLA', tipo: 'code', modulo: 'src/flujos/f3.js', funcion: 'revisar', pos: [440, 0] },
      { nombre: 'Guardar cambios', tipo: 'postgres', sql: 'select registrar_cambios($1::jsonb) as resultado', parametros: jsonParam('cambios'), pos: [660, 0] },
    ],
    conexiones: [
      ['Cada 15 minutos', 'Estado de respuestas'],
      ['Estado de respuestas', 'Revisar SLA'],
      ['Revisar SLA', 'Guardar cambios'],
    ],
  },
  {
    archivo: 'F4-tareas-completadas.json',
    clave: 'F4',
    nombre: 'Merch Caracas · F4 Tareas completadas',
    nodos: [
      { nombre: 'Cada 5 minutos', tipo: 'cron', cron: '*/5 * * * *', pos: [0, 0] },
      { nombre: 'Tareas abiertas', tipo: 'postgres', sql: 'select * from f4_tareas_abiertas()', pos: [220, 0] },
      { nombre: 'Procesar completadas', tipo: 'code', modulo: 'src/flujos/f4.js', funcion: 'procesar', pos: [440, 0] },
      { nombre: 'Guardar cambios', tipo: 'postgres', sql: 'select registrar_cambios($1::jsonb) as resultado', parametros: jsonParam('cambios'), pos: [660, 0] },
      { nombre: 'Clientes abiertos', tipo: 'postgres', sql: 'select * from f4_clientes_abiertos()', pos: [220, 200] },
      { nombre: 'Revisar traspasos', tipo: 'code', modulo: 'src/flujos/traspasos.js', funcion: 'revisar', pos: [440, 200] },
      { nombre: 'Guardar traspasos', tipo: 'postgres', sql: 'select registrar_cambios($1::jsonb) as resultado', parametros: jsonParam('cambios'), pos: [660, 200] },
    ],
    conexiones: [
      ['Cada 5 minutos', 'Tareas abiertas'],
      ['Tareas abiertas', 'Procesar completadas'],
      ['Procesar completadas', 'Guardar cambios'],
      ['Cada 5 minutos', 'Clientes abiertos'],
      ['Clientes abiertos', 'Revisar traspasos'],
      ['Revisar traspasos', 'Guardar traspasos'],
    ],
  },
  {
    archivo: 'F5-resumen-diario.json',
    clave: 'F5',
    nombre: 'Merch Caracas · F5 Resumen diario',
    nodos: [
      { nombre: 'Diario 7:30', tipo: 'cron', cron: '30 7 * * *', pos: [0, 0] },
      { nombre: 'Datos del día', tipo: 'postgres', sql: 'select f5_datos() as datos', pos: [220, 0] },
      { nombre: 'Enviar resumen', tipo: 'code', modulo: 'src/flujos/f5.js', funcion: 'resumir', pos: [440, 0] },
    ],
    conexiones: [
      ['Diario 7:30', 'Datos del día'],
      ['Datos del día', 'Enviar resumen'],
    ],
  },
];

function construirFlujo(f) {
  const nodes = f.nodos.map((d) => nodo(f.clave, d));
  const nombres = new Set(nodes.map((n) => n.name));
  const connections = {};
  for (const [desde, hacia] of f.conexiones) {
    if (!nombres.has(desde) || !nombres.has(hacia)) throw new Error(`Conexión inválida en ${f.clave}: ${desde} → ${hacia}`);
    connections[desde] = connections[desde] || { main: [[]] };
    connections[desde].main[0].push({ node: hacia, type: 'main', index: 0 });
  }
  return {
    // ID fijo: volver a importar con la CLI actualiza el flujo en vez de duplicarlo.
    id: `MerchCaracas${f.clave}`,
    name: f.nombre,
    nodes,
    connections,
    active: false,
    settings: { executionOrder: 'v1', timezone: ZONA, callerPolicy: 'workflowsFromSameOwner' },
    pinData: {},
    meta: { generadoPor: 'merch-caracas/n8n/construir.js' },
    tags: [],
  };
}

function main() {
  fs.mkdirSync(SALIDA, { recursive: true });
  for (const f of FLUJOS) {
    const destino = path.join(SALIDA, f.archivo);
    fs.writeFileSync(destino, `${JSON.stringify(construirFlujo(f), null, 2)}\n`);
    console.log(`✔ ${path.relative(RAIZ, destino)}`);
  }
}

if (require.main === module) main();

module.exports = { FLUJOS, construirFlujo, codigoNodo, empaquetar };
