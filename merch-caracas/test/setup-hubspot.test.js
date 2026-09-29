'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { asegurarPipeline, asegurarPropiedades, PROPIEDADES, NOMBRE_PIPELINE } = require('../hubspot/setup');
const { crearHubSpot } = require('../src/hubspot');
const { ETAPAS, MOTIVOS_PERDIDA } = require('../src/etapas');

// API de pipelines y propiedades simulada.
function falso() {
  const estado = { pipelines: [], grupos: [], propiedades: {}, llamadas: [] };
  let id = 1;
  const http = async ({ method, url, body }) => {
    const ruta = new URL(url).pathname;
    estado.llamadas.push(`${method} ${ruta}`);
    const ok = (b, status = 200) => ({ status, body: b, headers: {} });
    if (method === 'GET' && ruta === '/crm/v3/pipelines/deals') return ok({ results: JSON.parse(JSON.stringify(estado.pipelines)) });
    if (method === 'POST' && ruta === '/crm/v3/pipelines/deals') {
      const p = { id: `pl${id++}`, label: body.label, stages: body.stages.map((s) => ({ ...s, id: `st${id++}` })) };
      estado.pipelines.push(p);
      return ok(p, 201);
    }
    let m;
    if (method === 'POST' && (m = /^\/crm\/v3\/pipelines\/deals\/(\w+)\/stages$/.exec(ruta))) {
      const etapa = { ...body, id: `st${id++}` };
      estado.pipelines.find((p) => p.id === m[1]).stages.push(etapa);
      return ok(etapa, 201);
    }
    if (method === 'POST' && ruta === '/crm/v3/properties/deals/groups') {
      if (estado.grupos.includes(body.name)) return ok({ message: 'existe' }, 409);
      estado.grupos.push(body.name);
      return ok(body, 201);
    }
    if ((m = /^\/crm\/v3\/properties\/deals\/(\w+)$/.exec(ruta))) {
      if (method === 'GET') return estado.propiedades[m[1]] ? ok(estado.propiedades[m[1]]) : ok({ message: 'no' }, 404);
      if (method === 'PATCH') {
        Object.assign(estado.propiedades[m[1]], body);
        return ok(estado.propiedades[m[1]]);
      }
    }
    if (method === 'POST' && ruta === '/crm/v3/properties/deals') {
      estado.propiedades[body.name] = body;
      return ok(body, 201);
    }
    throw new Error(`no simulado: ${method} ${ruta}`);
  };
  return { estado, hs: crearHubSpot({ http, token: 't', apiUrl: 'http://hs', esperar: async () => {} }) };
}

test('crea el pipeline con las 9 etapas en orden y devuelve sus IDs', async () => {
  const { estado, hs } = falso();
  const { pipelineId, etapas } = await asegurarPipeline(hs);
  const [p] = estado.pipelines;
  assert.equal(p.label, NOMBRE_PIPELINE);
  assert.equal(pipelineId, p.id);
  assert.deepEqual(p.stages.map((s) => s.label), ETAPAS.map((e) => e.etiqueta));
  assert.deepEqual(p.stages.map((s) => s.displayOrder), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(p.stages[7].metadata, { probability: '1.00', isClosed: 'true' });
  assert.deepEqual(p.stages[8].metadata, { probability: '0.00', isClosed: 'true' });
  assert.deepEqual(p.stages[0].metadata, { probability: '0.10' });
  assert.deepEqual(Object.keys(etapas), ETAPAS.map((e) => e.clave));
});

test('es idempotente y completa etapas que falten', async () => {
  const { estado, hs } = falso();
  await asegurarPipeline(hs);
  estado.pipelines[0].stages.splice(3, 1); // alguien borró "Verificar pago"
  const { etapas } = await asegurarPipeline(hs);
  assert.equal(estado.pipelines.length, 1);
  assert.equal(estado.pipelines[0].stages.length, 9);
  assert.ok(etapas.verificar_pago);
});

test('crea grupo y propiedades; motivo_perdida con la lista cerrada', async () => {
  const { estado, hs } = falso();
  await asegurarPropiedades(hs);
  assert.deepEqual(Object.keys(estado.propiedades).sort(), PROPIEDADES.map((p) => p.name).sort());
  assert.equal(estado.propiedades.cantidad.type, 'number');
  assert.equal(estado.propiedades.fecha_entrega.type, 'date');
  assert.equal(estado.propiedades.resumen_ia.fieldType, 'textarea');
  assert.deepEqual(estado.propiedades.motivo_perdida.options.map((o) => o.label), MOTIVOS_PERDIDA);
  assert.ok(Object.values(estado.propiedades).every((p) => p.groupName === 'merch_caracas_whatsapp'));

  await asegurarPropiedades(hs); // segunda vez: no falla y actualiza opciones
  assert.ok(estado.llamadas.includes('PATCH /crm/v3/properties/deals/motivo_perdida'));

  estado.propiedades.cantidad.type = 'string';
  await assert.rejects(asegurarPropiedades(hs), /ya existe con tipo string/);
});
