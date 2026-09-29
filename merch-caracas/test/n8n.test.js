'use strict';

// Los flujos de n8n/workflows están al día con src/ y sus Code nodes corren en
// un entorno parecido al runner de n8n (variables $env, $input, $() y helpers).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { FLUJOS, construirFlujo } = require('../n8n/construir');
const { envPrueba, crearHubSpotFalso, ETAPAS_IDS } = require('./apoyo/falsos');

const CARPETA = path.join(__dirname, '..', 'n8n', 'workflows');

function codigo(flujo, nombre) {
  return flujo.nodes.find((n) => n.name === nombre).parameters.jsCode;
}

// Imita JsTaskRunner.runDirectly: with(context) { async function() { código } }
async function correrCodeNode(jsCode, { env, items, nodos = {}, http }) {
  const contexto = {
    $env: env,
    $input: { all: () => items.map((json) => ({ json })) },
    $: (nombre) => ({ first: () => ({ json: nodos[nombre] }) }),
    helpers: {
      httpRequest: async (o) => {
        assert.equal(o.json, true);
        assert.equal(o.returnFullResponse, true);
        assert.equal(o.ignoreHttpStatusErrors, true);
        const r = await http(o);
        return { statusCode: r.status, body: r.body, headers: r.headers };
      },
    },
    setTimeout,
  };
  const fn = new Function('context', `with(context) { return (async function() {${jsCode}\n})(); }`);
  return fn(contexto);
}

test('los flujos generados están al día con src/ (corre npm run n8n:construir)', () => {
  for (const f of FLUJOS) {
    const archivo = JSON.parse(fs.readFileSync(path.join(CARPETA, f.archivo), 'utf8'));
    const esperado = construirFlujo(f);
    assert.deepEqual(archivo.nodes.map((n) => [n.name, n.type, n.typeVersion]), esperado.nodes.map((n) => [n.name, n.type, n.typeVersion]));
    assert.deepEqual(archivo.connections, esperado.connections);
    for (const n of esperado.nodes) {
      const guardado = archivo.nodes.find((x) => x.name === n.name);
      assert.deepEqual(guardado.parameters, n.parameters, `${f.archivo} · ${n.name}`);
    }
  }
});

test('estructura de los flujos', () => {
  for (const f of FLUJOS) {
    const w = construirFlujo(f);
    const nombres = new Set(w.nodes.map((n) => n.name));
    assert.equal(nombres.size, w.nodes.length, 'nombres únicos');
    assert.equal(new Set(w.nodes.map((n) => n.id)).size, w.nodes.length, 'ids únicos');
    const triggers = w.nodes.filter((n) => /webhook|scheduleTrigger/.test(n.type));
    assert.equal(triggers.length, 1, `${f.clave}: un disparador`);
    for (const [desde, { main }] of Object.entries(w.connections)) {
      assert.ok(nombres.has(desde));
      for (const c of main[0]) assert.ok(nombres.has(c.node));
    }
    for (const n of w.nodes.filter((x) => x.type === 'n8n-nodes-base.postgres')) {
      assert.equal(n.parameters.operation, 'executeQuery');
      assert.ok(n.credentials.postgres.name);
    }
    for (const n of w.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
      assert.doesNotThrow(() => new Function(`return (async function() {${n.parameters.jsCode}\n})`), `${f.clave} · ${n.name} compila`);
      assert.match(n.parameters.jsCode, /\$env/);
      assert.doesNotMatch(n.parameters.jsCode, /require\('(fs|path|crypto|pg)'\)/);
    }
    assert.equal(w.settings.timezone, 'America/Caracas');
    assert.equal(w.active, false);
  }
});

test('F1 en runner simulado: webhook → mensajes normalizados', async () => {
  const w = construirFlujo(FLUJOS.find((f) => f.clave === 'F1'));
  const salida = await correrCodeNode(codigo(w, 'Normalizar mensajes'), {
    env: envPrueba(),
    items: [{ headers: { 'x-webhook-secret': 'secreto-de-prueba-123456789' }, query: {}, body: require('./fixtures/mensaje-texto.json') }],
    http: async () => { throw new Error('no debería llamar a HTTP'); },
  });
  assert.equal(salida.length, 1);
  assert.equal(salida[0].json.mensajes[0].telefono, '+584141234567');
});

test('F1 en runner simulado: crear en HubSpot usa $() y helpers.httpRequest', async () => {
  const w = construirFlujo(FLUJOS.find((f) => f.clave === 'F1'));
  const hubspot = crearHubSpotFalso();
  const salida = await correrCodeNode(codigo(w, 'Crear en HubSpot'), {
    env: envPrueba({ HUBSPOT_API_URL: 'http://hubspot.prueba' }),
    items: [{ telefono: '+584141234567', hubspot_owner_id: '1', vendedor_nombre: 'Ana', metodo: 'rotacion' }],
    nodos: { 'Buscar en HubSpot': { busquedas: { '+584141234567': { nombre_wa: 'Luis' } } } },
    http: hubspot.http,
  });
  assert.equal(salida[0].json.cambios.clientes[0].etapa, 'nuevo');
  assert.equal(Object.values(hubspot.datos.deals)[0].properties.dealstage, ETAPAS_IDS.nuevo);
});

test('el prompt empaquetado en F2 es el de prompts/clasificador.md', () => {
  const w = construirFlujo(FLUJOS.find((f) => f.clave === 'F2'));
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'clasificador.md'), 'utf8');
  assert.ok(codigo(w, 'Analizar con Claude').includes(JSON.stringify(prompt)));
});
