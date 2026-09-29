'use strict';

// Instalación para Supabase (supabase/instalar.sql) y servidor de la Edge
// Function (src/supabase.js) contra Postgres real, con Vault, pg_cron y pg_net
// simulados y HubSpot, Claude y 360dialog falsos.
//
// Necesita TEST_DATABASE_URL de un usuario que pueda crear bases: crea una base
// temporal, la usa y la borra (no toca ninguna otra).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { construirSql, construirFuncion } = require('../supabase/construir');
const { crearManejador } = require('../src/supabase');
const { crearHubSpotFalso, crearClaudeFalso, analisis } = require('./apoyo/falsos');

const URL_BD = process.env.TEST_DATABASE_URL;
const opciones = { skip: URL_BD ? false : 'define TEST_DATABASE_URL para correr las pruebas de Supabase' };
const SIMULADO = fs.readFileSync(path.join(__dirname, 'apoyo', 'supabase-simulado.sql'), 'utf8');

test('los archivos de supabase/ están al día (corre node supabase/construir.js)', () => {
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'instalar.sql'), 'utf8'), construirSql());
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'merch', 'index.ts'), 'utf8'), construirFuncion());
});

async function conBaseTemporal(fn) {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: URL_BD });
  await admin.connect();
  const nombre = `merch_supabase_${process.pid}_${Date.now()}`;
  await admin.query(`create database ${nombre}`);
  const url = new URL(URL_BD);
  url.pathname = `/${nombre}`;
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  try {
    await pool.query('set client_min_messages = warning');
    await pool.query(SIMULADO);
    await pool.query(construirSql());
    await fn(pool);
  } finally {
    await pool.end();
    await admin.query(`drop database if exists ${nombre} with (force)`);
    await admin.end();
  }
}

function montar(pool, { claude = crearClaudeFalso() } = {}) {
  const hubspot = crearHubSpotFalso();
  const d360 = [];
  const pendientes = [];
  const http = async (o) => {
    if (o.url.startsWith('http://claude.prueba')) return claude.http(o);
    if (o.url.startsWith('http://d360.prueba')) {
      d360.push(o);
      return { status: 200, body: o.method === 'GET' ? { url: 'configurada' } : { ok: true }, headers: {} };
    }
    return hubspot.http(o);
  };
  const manejar = crearManejador({
    consultar: (texto, parametros) => pool.query(texto, parametros).then((r) => r.rows),
    envBase: {
      SUPABASE_URL: 'https://abc123.supabase.co',
      HUBSPOT_PRIVATE_APP_TOKEN: 'token',
      HUBSPOT_API_URL: 'http://hubspot.prueba',
      ANTHROPIC_API_KEY: 'clave',
      ANTHROPIC_API_URL: 'http://claude.prueba',
      D360_API_KEY: 'd360',
      D360_API_URL: 'http://d360.prueba',
    },
    http,
    enSegundoPlano: (p) => pendientes.push(p),
    esperar: async () => {},
  });
  const pedir = async (ruta, { metodo = 'POST', body, headers = {}, query = '' } = {}) => {
    const r = await manejar(new Request(`http://localhost/functions/v1/merch/${ruta}${query}`, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined || metodo === 'GET' ? undefined : JSON.stringify(body),
    }));
    await Promise.all(pendientes.splice(0));
    return { status: r.status, json: await r.json() };
  };
  return { hubspot, claude, d360, pedir };
}

const q = async (pool, sql, p) => (await pool.query(sql, p)).rows;
const secreto = async (pool, nombre) => (await q(pool, 'select decrypted_secret as v from vault.decrypted_secrets where name = $1', [nombre]))[0].v;
const bitacora = async (pool, ruta) => (await q(pool, 'select ok, detalle from merch.bitacora where ruta = $1 order by id desc limit 1', [ruta]))[0];

test('Supabase: instalación, salud, HubSpot, webhook de WhatsApp, flujos y 360dialog', opciones, () => conBaseTemporal(async (pool) => {
  const { hubspot, claude, d360, pedir } = montar(pool);

  // salud registra la URL de la función en Vault y dice qué falta
  const salud = await pedir('salud', { metodo: 'GET' });
  assert.equal(salud.status, 200);
  assert.equal(salud.json.url_funcion, 'https://abc123.supabase.co/functions/v1/merch');
  assert.equal(await secreto(pool, 'merch_url_funcion'), 'https://abc123.supabase.co/functions/v1/merch');
  assert.ok(salud.json.flujos.f1.faltan.includes('HORARIO_LABORAL'));
  assert.ok(salud.json.flujos.f1.faltan.includes('HUBSPOT_ETAPA_NUEVO'));
  assert.equal(salud.json.flujos.f1.faltan.includes('D360_WEBHOOK_SECRET'), false, 'el secreto del webhook sale de Vault');
  assert.equal(salud.json.flujos.f2.activo, false);
  assert.equal(salud.json.d360_api_key, true);
  assert.doesNotMatch(JSON.stringify(salud.json), new RegExp(await secreto(pool, 'merch_webhook_secreto')));

  // el cron llama con su secreto; sin él, 401
  const [{ llamar }] = await q(pool, "select merch.llamar('f2') as llamar");
  const [solicitud] = await q(pool, 'select url, headers, timeout_milliseconds from net.solicitudes where id = $1', [llamar]);
  assert.equal(solicitud.url, 'https://abc123.supabase.co/functions/v1/merch/f2');
  const cron = { 'x-cron-secreto': solicitud.headers['x-cron-secreto'] };
  assert.equal(cron['x-cron-secreto'], await secreto(pool, 'merch_cron_secreto'));
  assert.equal((await pedir('f2')).status, 401);
  assert.equal((await pedir('f2', { headers: { 'x-cron-secreto': 'otro' } })).status, 401);
  assert.deepEqual((await pedir('f2', { headers: cron })).json, { omitido: 'f2 está desactivado en merch.configuracion' });

  // hubspot-setup crea el pipeline y guarda los IDs en merch.configuracion
  const setup = await pedir('hubspot-setup', { headers: cron });
  assert.equal(setup.status, 202);
  const anotado = await bitacora(pool, 'hubspot-setup');
  assert.equal(anotado.ok, true, JSON.stringify(anotado.detalle));
  assert.equal(anotado.detalle.usuarios.length, 3);
  const config = Object.fromEntries((await q(pool, 'select clave, valor from merch.configuracion')).map((f) => [f.clave, f.valor]));
  assert.equal(config.HUBSPOT_PIPELINE_ID, hubspot.pipelines[0].id);
  assert.equal(config.HUBSPOT_ETAPA_NUEVO, hubspot.pipelines[0].stages[0].id);
  assert.ok(hubspot.propiedades.motivo_perdida);

  // datos de Oscar: horario y vendedores
  await pool.query("update merch.configuracion set valor = 'lun-dom 00:00-24:00' where clave = 'HORARIO_LABORAL'");
  await pool.query("insert into merch.vendedores (nombre, hubspot_owner_id, orden) values ('Ana', '1', 1)");

  // webhook de WhatsApp: secreto de Vault por ?secreto=
  const cuerpo = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mensaje-texto.json'), 'utf8'));
  cuerpo.entry[0].changes[0].value.messages[0].timestamp = String(Math.floor(Date.now() / 1000) - 600);
  assert.equal((await pedir('whatsapp', { body: cuerpo, query: '?secreto=malo' })).status, 401);
  const wa = await pedir('whatsapp', { body: cuerpo, query: `?secreto=${await secreto(pool, 'merch_webhook_secreto')}` });
  assert.deepEqual([wa.status, wa.json], [200, { ok: true }]);
  const f1 = await bitacora(pool, 'f1');
  assert.equal(f1.ok, true, JSON.stringify(f1.detalle));
  assert.deepEqual(f1.detalle, { mensajes: 1, clientes: 1, altas: 1, respondidas: 0 });
  const [cliente] = await q(pool, 'select * from merch.clientes');
  assert.equal(cliente.vendedor_id, 1);
  assert.equal(hubspot.datos.deals[cliente.hubspot_deal_id].properties.dealstage, config.HUBSPOT_ETAPA_NUEVO);
  assert.equal(hubspot.tareas()[0].properties.hs_task_subject, 'Contestar a Luis Rojas');

  // F2 activado: analiza con Claude
  await pool.query("update merch.configuracion set valor = 'true' where clave = 'F2_ACTIVO'");
  await pool.query("update merch.configuracion set valor = '0' where clave = 'DEBOUNCE_MIN'");
  claude.responder(analisis({ etapa_detectada: 'solicitud', datos_pedido: { producto: 'termos', cantidad: 200, fecha_entrega: null, empresa_cliente: null } }));
  assert.equal((await pedir('f2', { headers: cron })).status, 202);
  const f2 = await bitacora(pool, 'f2');
  assert.equal(f2.ok, true, JSON.stringify(f2.detalle));
  assert.equal(f2.detalle.ok, 1);
  const [a] = await q(pool, 'select modo, etapa_detectada from merch.analisis');
  assert.deepEqual(a, { modo: 'sombra', etapa_detectada: 'solicitud' });
  assert.equal(claude.solicitudes[0].model, 'claude-sonnet-5-5');

  // F3, F4 y F5 activados
  await pool.query("update merch.configuracion set valor = 'true' where clave in ('F3_ACTIVO', 'F4_ACTIVO', 'F5_ACTIVO')");
  await pool.query("update merch.configuracion set valor = '900' where clave = 'ADMIN_HUBSPOT_OWNER_ID'");
  for (const f of ['f3', 'f4', 'f5']) {
    assert.equal((await pedir(f, { headers: cron })).status, 202, f);
    const r = await bitacora(pool, f);
    assert.equal(r.ok, true, `${f}: ${JSON.stringify(r.detalle)}`);
  }
  assert.ok(hubspot.tareas().some((t) => /^Resumen WhatsApp/.test(t.properties.hs_task_subject)));

  // configurar-webhook apunta 360dialog a la función con el secreto de Vault
  assert.equal((await pedir('configurar-webhook', { headers: cron })).status, 202);
  const w = await bitacora(pool, 'configurar-webhook');
  assert.equal(w.ok, true, JSON.stringify(w.detalle));
  const post = d360.find((o) => o.method === 'POST');
  assert.equal(post.headers['D360-API-KEY'], 'd360');
  assert.equal(post.body.url, `https://abc123.supabase.co/functions/v1/merch/whatsapp?secreto=${await secreto(pool, 'merch_webhook_secreto')}`);

  // errores: se anotan en la bitácora
  hubspot.fallar('POST', /\/crm\/v3\/objects\/deals\/search$/, 500, 10);
  const otro = JSON.parse(JSON.stringify(cuerpo));
  otro.entry[0].changes[0].value.messages[0].from = '584149999999';
  otro.entry[0].changes[0].value.contacts[0].wa_id = '584149999999';
  otro.entry[0].changes[0].value.messages[0].id = 'wamid.OTRO';
  await pedir('whatsapp', { body: otro, query: `?secreto=${await secreto(pool, 'merch_webhook_secreto')}` });
  const fallo = await bitacora(pool, 'f1');
  assert.equal(fallo.ok, false);
  assert.match(fallo.detalle.error, /HubSpot POST .* 500/);

  assert.equal((await pedir('otra', { headers: cron })).status, 404);
  assert.equal((await pedir('f2', { metodo: 'GET' })).status, 405);
}));

// Ejecuta el index.ts generado tal cual (sin el import de npm) con Deno y
// postgres simulados: detecta módulos que falten en el empaquetado.
test('el index.ts generado arranca y responde /salud', async () => {
  const codigo = construirFuncion().replace(/^import postgres from 'npm:postgres@[\d.]+';$/m, '');
  let manejar;
  const Deno = {
    env: {
      get: (k) => ({ SUPABASE_DB_URL: 'postgres://simulado' })[k],
      toObject: () => ({ SUPABASE_URL: 'https://abc123.supabase.co' }),
    },
    serve: (fn) => { manejar = fn; },
  };
  const consultas = [];
  const postgres = () => ({
    unsafe: async (texto, parametros) => {
      consultas.push(texto);
      if (/decrypted_secrets/.test(texto)) return [];
      if (/count\(\*\)/.test(texto)) return [{ n: 0, w: 0 }];
      return [];
    },
  });
  new Function('Deno', 'postgres', 'EdgeRuntime', codigo)(Deno, postgres, undefined);
  assert.equal(typeof manejar, 'function');
  const r = await manejar(new Request('http://localhost/functions/v1/merch/salud'));
  assert.equal(r.status, 200);
  const cuerpo = await r.json();
  assert.equal(cuerpo.url_funcion, 'https://abc123.supabase.co/functions/v1/merch');
  assert.ok(consultas.some((c) => /vault\.create_secret/.test(c)));
});
