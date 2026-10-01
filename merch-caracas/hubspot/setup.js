#!/usr/bin/env node
'use strict';

// Crea en HubSpot (o completa, si ya existe) todo lo que usa el sistema:
//   - pipeline de negocios "Ventas" con sus 9 etapas (renombra "WhatsApp Ventas")
//   - grupo y propiedades personalizadas del negocio
//   - propiedad "motivo_perdida" con la lista cerrada de motivos
//   - propiedad "canal" (WhatsApp / Correo)
// y guarda los IDs en config/hubspot.json. Al final imprime las líneas para .env
// y la lista de usuarios (propietarios) de HubSpot para cargar la tabla vendedores.
//
// Uso: HUBSPOT_PRIVATE_APP_TOKEN=... node hubspot/setup.js
// Se puede correr varias veces: no duplica nada.

const fs = require('fs');
const path = require('path');
const { cargarEnv, http } = require('../scripts/lib');
const { crearHubSpot } = require('../src/hubspot');
const { ETAPAS } = require('../src/etapas');
const { asegurarPipeline, asegurarPropiedades, PROPIEDADES, NOMBRE_PIPELINE } = require('../src/hubspot-setup');

async function main() {
  cargarEnv();
  const hs = crearHubSpot({ http, token: process.env.HUBSPOT_PRIVATE_APP_TOKEN, apiUrl: process.env.HUBSPOT_API_URL || undefined });

  const { pipelineId, etapas } = await asegurarPipeline(hs, console.log, { pipelineId: process.env.HUBSPOT_PIPELINE_ID });
  await asegurarPropiedades(hs);

  const destino = path.join(__dirname, '..', 'config', 'hubspot.json');
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, `${JSON.stringify({ pipelineId, etapas, generado: new Date().toISOString() }, null, 2)}\n`);
  console.log(`\n✔ IDs guardados en ${path.relative(process.cwd(), destino)}`);

  console.log('\nAgrega estas líneas al .env (y a las variables de entorno de n8n):\n');
  console.log(`HUBSPOT_PIPELINE_ID=${pipelineId}`);
  console.log('HUBSPOT_CANAL=true');
  for (const e of ETAPAS) console.log(`HUBSPOT_ETAPA_${e.clave.toUpperCase()}=${etapas[e.clave]}`);

  try {
    const owners = await hs.listarPropietarios();
    console.log('\nUsuarios de HubSpot (para la tabla vendedores; ver db/vendedores.ejemplo.sql):\n');
    for (const o of owners) {
      console.log(`  ${o.id}\t${[o.firstName, o.lastName].filter(Boolean).join(' ')}\t${o.email || ''}`);
    }
  } catch (error) {
    console.log(`\n(No se pudo listar los usuarios: ${error.message})`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n✘ ${error.message}`);
    process.exit(1);
  });
}

module.exports = { asegurarPipeline, asegurarPropiedades, PROPIEDADES, NOMBRE_PIPELINE };
