#!/usr/bin/env node
'use strict';

// Crea en HubSpot (o completa, si ya existe) todo lo que usa el sistema:
//   - pipeline de negocios "WhatsApp Ventas" con sus 9 etapas
//   - grupo y propiedades personalizadas del negocio
//   - propiedad "motivo_perdida" con la lista cerrada de motivos
// y guarda los IDs en config/hubspot.json. Al final imprime las líneas para .env
// y la lista de usuarios (propietarios) de HubSpot para cargar la tabla vendedores.
//
// Uso: HUBSPOT_PRIVATE_APP_TOKEN=... node hubspot/setup.js
// Se puede correr varias veces: no duplica nada.

const fs = require('fs');
const path = require('path');
const { cargarEnv, http } = require('../scripts/lib');
const { crearHubSpot } = require('../src/hubspot');
const { ETAPAS, MOTIVOS_PERDIDA } = require('../src/etapas');

const NOMBRE_PIPELINE = 'WhatsApp Ventas';
const GRUPO = { name: 'merch_caracas_whatsapp', label: 'WhatsApp (Merch Caracas)', displayOrder: -1 };

const PROPIEDADES = [
  { name: 'wa_telefono', label: 'WhatsApp (E.164)', type: 'string', fieldType: 'text',
    description: 'Teléfono de WhatsApp del cliente en formato E.164. Clave para cruzar con WhatsApp.' },
  { name: 'producto', label: 'Producto', type: 'string', fieldType: 'text',
    description: 'Producto solicitado, según la conversación.' },
  { name: 'cantidad', label: 'Cantidad', type: 'number', fieldType: 'number',
    description: 'Unidades solicitadas.' },
  { name: 'fecha_entrega', label: 'Fecha de entrega', type: 'date', fieldType: 'date',
    description: 'Fecha en que el cliente necesita el pedido.' },
  { name: 'empresa_cliente', label: 'Empresa del cliente', type: 'string', fieldType: 'text',
    description: 'Empresa del cliente, según la conversación.' },
  { name: 'resumen_ia', label: 'Resumen IA', type: 'string', fieldType: 'textarea',
    description: 'Último resumen de la conversación hecho por Claude.' },
  { name: 'motivo_perdida', label: 'Motivo de pérdida', type: 'enumeration', fieldType: 'select',
    description: 'Motivo por el que se perdió el negocio (lo elige el vendedor al pasarlo a Perdido).',
    options: MOTIVOS_PERDIDA.map((m, i) => ({ label: m, value: m, displayOrder: i })) },
];

function metadataEtapa(e) {
  const m = { probability: e.probabilidad.toFixed(2) };
  if (e.cerrada) m.isClosed = 'true';
  return m;
}

async function asegurarPipeline(hs) {
  const r = await hs.solicitud('GET', '/crm/v3/pipelines/deals');
  let pipeline = (r.body.results || []).find((p) => p.label === NOMBRE_PIPELINE);

  if (!pipeline) {
    const creado = await hs.solicitud('POST', '/crm/v3/pipelines/deals', {
      label: NOMBRE_PIPELINE,
      displayOrder: 1,
      stages: ETAPAS.map((e) => ({ label: e.etiqueta, displayOrder: e.orden, metadata: metadataEtapa(e) })),
    });
    pipeline = creado.body;
    console.log(`✔ Pipeline "${NOMBRE_PIPELINE}" creado (${pipeline.id})`);
  } else {
    console.log(`• Pipeline "${NOMBRE_PIPELINE}" ya existe (${pipeline.id})`);
    for (const e of ETAPAS) {
      if (pipeline.stages.some((s) => s.label === e.etiqueta)) continue;
      const etapa = await hs.solicitud('POST', `/crm/v3/pipelines/deals/${pipeline.id}/stages`, {
        label: e.etiqueta, displayOrder: e.orden, metadata: metadataEtapa(e),
      });
      pipeline.stages.push(etapa.body);
      console.log(`  ✔ Etapa "${e.etiqueta}" agregada`);
    }
  }

  const etapas = {};
  for (const e of ETAPAS) {
    const s = pipeline.stages.find((x) => x.label === e.etiqueta);
    if (!s) throw new Error(`No se encontró la etapa "${e.etiqueta}" en el pipeline`);
    etapas[e.clave] = s.id;
  }
  return { pipelineId: pipeline.id, etapas };
}

async function asegurarPropiedades(hs) {
  const g = await hs.solicitud('POST', '/crm/v3/properties/deals/groups', GRUPO, { aceptar: [409] });
  console.log(g.status === 409 ? `• Grupo "${GRUPO.label}" ya existe` : `✔ Grupo "${GRUPO.label}" creado`);

  for (const prop of PROPIEDADES) {
    const actual = await hs.solicitud('GET', `/crm/v3/properties/deals/${prop.name}`, undefined, { aceptar: [404] });
    if (actual.status === 404) {
      await hs.solicitud('POST', '/crm/v3/properties/deals', { ...prop, groupName: GRUPO.name });
      console.log(`✔ Propiedad ${prop.name} creada`);
    } else if (actual.body.type !== prop.type) {
      throw new Error(`La propiedad ${prop.name} ya existe con tipo ${actual.body.type} (se esperaba ${prop.type}). Revísala en HubSpot.`);
    } else if (prop.options) {
      await hs.solicitud('PATCH', `/crm/v3/properties/deals/${prop.name}`, { options: prop.options });
      console.log(`• Propiedad ${prop.name} ya existe: opciones actualizadas`);
    } else {
      console.log(`• Propiedad ${prop.name} ya existe`);
    }
  }
}

async function main() {
  cargarEnv();
  const hs = crearHubSpot({ http, token: process.env.HUBSPOT_PRIVATE_APP_TOKEN, apiUrl: process.env.HUBSPOT_API_URL || undefined });

  const { pipelineId, etapas } = await asegurarPipeline(hs);
  await asegurarPropiedades(hs);

  const destino = path.join(__dirname, '..', 'config', 'hubspot.json');
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, `${JSON.stringify({ pipelineId, etapas, generado: new Date().toISOString() }, null, 2)}\n`);
  console.log(`\n✔ IDs guardados en ${path.relative(process.cwd(), destino)}`);

  console.log('\nAgrega estas líneas al .env (y a las variables de entorno de n8n):\n');
  console.log(`HUBSPOT_PIPELINE_ID=${pipelineId}`);
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
