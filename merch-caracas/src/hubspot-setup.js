'use strict';

// Crea en HubSpot (o completa, si ya existe) lo que usa el sistema: pipeline
// "WhatsApp Ventas" con sus 9 etapas, grupo y propiedades del negocio y la
// propiedad motivo_perdida con la lista cerrada de motivos. Se puede repetir.
// Lo usan hubspot/setup.js (línea de comandos) y la función de Supabase.

const { ETAPAS, MOTIVOS_PERDIDA } = require('./etapas');

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

async function asegurarPipeline(hs, log = console.log) {
  const r = await hs.solicitud('GET', '/crm/v3/pipelines/deals');
  let pipeline = (r.body.results || []).find((p) => p.label === NOMBRE_PIPELINE);

  if (!pipeline) {
    const creado = await hs.solicitud('POST', '/crm/v3/pipelines/deals', {
      label: NOMBRE_PIPELINE,
      displayOrder: 1,
      stages: ETAPAS.map((e) => ({ label: e.etiqueta, displayOrder: e.orden, metadata: metadataEtapa(e) })),
    });
    pipeline = creado.body;
    log(`✔ Pipeline "${NOMBRE_PIPELINE}" creado (${pipeline.id})`);
  } else {
    log(`• Pipeline "${NOMBRE_PIPELINE}" ya existe (${pipeline.id})`);
    for (const e of ETAPAS) {
      if (pipeline.stages.some((s) => s.label === e.etiqueta)) continue;
      const etapa = await hs.solicitud('POST', `/crm/v3/pipelines/deals/${pipeline.id}/stages`, {
        label: e.etiqueta, displayOrder: e.orden, metadata: metadataEtapa(e),
      });
      pipeline.stages.push(etapa.body);
      log(`  ✔ Etapa "${e.etiqueta}" agregada`);
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

async function asegurarPropiedades(hs, log = console.log) {
  const g = await hs.solicitud('POST', '/crm/v3/properties/deals/groups', GRUPO, { aceptar: [409] });
  log(g.status === 409 ? `• Grupo "${GRUPO.label}" ya existe` : `✔ Grupo "${GRUPO.label}" creado`);

  for (const prop of PROPIEDADES) {
    const actual = await hs.solicitud('GET', `/crm/v3/properties/deals/${prop.name}`, undefined, { aceptar: [404] });
    if (actual.status === 404) {
      await hs.solicitud('POST', '/crm/v3/properties/deals', { ...prop, groupName: GRUPO.name });
      log(`✔ Propiedad ${prop.name} creada`);
    } else if (actual.body.type !== prop.type) {
      throw new Error(`La propiedad ${prop.name} ya existe con tipo ${actual.body.type} (se esperaba ${prop.type}). Revísala en HubSpot.`);
    } else if (prop.options) {
      await hs.solicitud('PATCH', `/crm/v3/properties/deals/${prop.name}`, { options: prop.options });
      log(`• Propiedad ${prop.name} ya existe: opciones actualizadas`);
    } else {
      log(`• Propiedad ${prop.name} ya existe`);
    }
  }
}

module.exports = { asegurarPipeline, asegurarPropiedades, PROPIEDADES, NOMBRE_PIPELINE, GRUPO };
