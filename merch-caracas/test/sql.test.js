'use strict';

// Funciones de Postgres (db/migraciones) y F1/F2/F4 de punta a punta con
// Postgres real + HubSpot/Claude simulados, encadenando los pasos igual que n8n.
//
// Necesita TEST_DATABASE_URL (se salta si no está). Usa el esquema "prueba",
// que se borra y se vuelve a crear en cada prueba.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const f1 = require('../src/flujos/f1');
const f2 = require('../src/flujos/f2');
const f4 = require('../src/flujos/f4');
const traspasos = require('../src/flujos/traspasos');
const { crearCtx, envPrueba, analisis, ETAPAS_IDS } = require('./apoyo/falsos');

const URL_BD = process.env.TEST_DATABASE_URL;
const opciones = { skip: URL_BD ? false : 'define TEST_DATABASE_URL para correr las pruebas de Postgres' };

let pg;
async function conectar() {
  pg = pg || require('pg');
  const db = new pg.Client({ connectionString: URL_BD });
  await db.connect();
  await db.query('set client_min_messages = warning');
  await db.query('drop schema if exists prueba cascade; create schema prueba; set search_path = prueba');
  const carpeta = path.join(__dirname, '..', 'db', 'migraciones');
  for (const archivo of fs.readdirSync(carpeta).sort()) {
    await db.query(fs.readFileSync(path.join(carpeta, archivo), 'utf8'));
  }
  return db;
}

async function conBD(fn) {
  const db = await conectar();
  try {
    await fn(db);
  } finally {
    await db.end();
  }
}

const q = async (db, sql, params) => (await db.query(sql, params)).rows;
const json = (v) => JSON.stringify(v);

function msg(id, telefono, direccion, minutosAtras, extra = {}) {
  return {
    id, telefono, direccion, tipo: 'text', texto: id, media_id: null,
    ts: new Date(Date.now() - minutosAtras * 60000).toISOString(),
    nombre_wa: direccion === 'entrante' ? 'Luis' : null,
    origen: direccion === 'entrante' ? 'messages' : 'echo', raw: {}, ...extra,
  };
}

async function vendedores(db) {
  await db.query(`insert into vendedores (nombre, hubspot_owner_id, orden, disponible) values
    ('Ana', '1', 1, true), ('Beto', '2', 2, false), ('Caro', '3', 3, true)`);
}

const registrar = (db, mensajes) => q(db, 'select * from f1_registrar_mensajes($1::jsonb)', [json(mensajes)]);
const asignar = (db, a) => q(db, 'select * from f1_asignar_vendedor($1::jsonb)', [json(a)]);
const cliente = async (db, tel) => (await q(db, 'select * from clientes where telefono = $1', [tel]))[0];

test('F1 SQL: deduplica, pide alta una sola vez y respeta el candado', opciones, () => conBD(async (db) => {
  const m1 = msg('w1', '+581', 'entrante', 10);
  let r = await registrar(db, [m1, m1]);
  assert.equal(r.length, 1);
  assert.equal(r[0].necesita_alta, true);
  assert.equal(r[0].nombre_wa, 'Luis');
  assert.equal((await q(db, 'select count(*)::int as n from mensajes'))[0].n, 1);

  r = await registrar(db, [m1]);
  assert.equal(r.length, 0, 'repetido: nada nuevo');

  r = await registrar(db, [msg('w2', '+581', 'entrante', 9)]);
  assert.equal(r[0].necesita_alta, false, 'candado activo');

  await db.query("update clientes set alta_intentada_at = now() - interval '6 minutes'");
  const m3 = msg('w3', '+581', 'entrante', 8);
  r = await registrar(db, [m3]);
  assert.equal(r[0].necesita_alta, true, 'candado vencido: se reintenta');

  const c = await cliente(db, '+581');
  assert.equal(c.pendiente_analisis, true);
  assert.equal(c.ultimo_msg_cliente_at.toISOString(), m3.ts);
}));

test('F1 SQL: historial, reacciones, desorden y eco que completa "contestar"', opciones, () => conBD(async (db) => {
  let r = await registrar(db, [
    msg('h1', '+582', 'entrante', 600, { origen: 'history' }),
    msg('h2', '+582', 'saliente', 590, { origen: 'history' }),
  ]);
  assert.equal(r[0].necesita_alta, false, 'el historial no crea negocios');
  let c = await cliente(db, '+582');
  assert.equal(c.pendiente_analisis, false, 'el historial no se analiza');
  assert.ok(c.ultimo_msg_empresa_at > c.ultimo_msg_cliente_at);

  // cliente escribe; se registra su tarea contestar
  await registrar(db, [msg('e1', '+582', 'entrante', 5)]);
  await db.query("update clientes set hubspot_deal_id = 'd1' where telefono = '+582'");
  await db.query("insert into tareas (hubspot_task_id, telefono, tipo) values ('t1', '+582', 'contestar'), ('t2', '+582', 'cotizar')");

  r = await registrar(db, [msg('r1', '+582', 'saliente', 4, { tipo: 'reaction' })]);
  assert.deepEqual(r[0].tareas_contestar_completar, [], 'una reacción no es respuesta');

  // eco viejo que llega tarde (antes del mensaje del cliente): no completa
  const s0 = msg('s0', '+582', 'saliente', 6);
  r = await registrar(db, [s0]);
  assert.deepEqual(r[0].tareas_contestar_completar, []);
  c = await cliente(db, '+582');
  assert.equal(c.ultimo_msg_empresa_at.toISOString(), s0.ts);

  r = await registrar(db, [msg('s1', '+582', 'saliente', 2)]);
  assert.deepEqual(r[0].tareas_contestar_completar, ['t1']);
}));

test('F1 SQL: rotación por orden, salta no disponibles, vuelve a empezar y respeta vendedor previo', opciones, () => conBD(async (db) => {
  await vendedores(db);
  for (const t of ['+591', '+592', '+593', '+594']) await registrar(db, [msg(`m${t}`, t, 'entrante', 1)]);
  const r1 = await asignar(db, [{ telefono: '+591', hubspot_owner_id: null }]);
  const r2 = await asignar(db, [{ telefono: '+592', hubspot_owner_id: null }]);
  const r3 = await asignar(db, [{ telefono: '+593', hubspot_owner_id: null }]);
  assert.deepEqual([r1, r2, r3].map((r) => [r[0].vendedor_nombre, r[0].metodo]), [
    ['Ana', 'rotacion'], ['Caro', 'rotacion'], ['Ana', 'rotacion'],
  ]);
  // propietario previo en HubSpot (aunque no esté disponible) → se respeta
  const r4 = await asignar(db, [{ telefono: '+594', hubspot_owner_id: '2' }]);
  assert.deepEqual([r4[0].vendedor_nombre, r4[0].metodo], ['Beto', 'hubspot']);
  // propietario que no es vendedor → rotación (sigue Caro)
  await registrar(db, [msg('m5', '+595', 'entrante', 1)]);
  const r5 = await asignar(db, [{ telefono: '+595', hubspot_owner_id: '999' }]);
  assert.equal(r5[0].vendedor_nombre, 'Caro');
  // ya asignado → mismo vendedor, no gasta turno
  const r6 = await asignar(db, [{ telefono: '+591', hubspot_owner_id: null }]);
  assert.deepEqual([r6[0].vendedor_nombre, r6[0].metodo], ['Ana', 'existente']);
  assert.equal((await q(db, 'select ultimo_vendedor_id from rotacion'))[0].ultimo_vendedor_id, 3);

  await db.query('update vendedores set disponible = false');
  await registrar(db, [msg('m7', '+597', 'entrante', 1)]);
  await assert.rejects(asignar(db, [{ telefono: '+597', hubspot_owner_id: null }]), /No hay vendedores disponibles/);
}));

test('registrar_cambios: clientes, tareas nuevas y estados', opciones, () => conBD(async (db) => {
  await vendedores(db);
  await registrar(db, [msg('a', '+581', 'entrante', 1)]);
  const r = await q(db, 'select registrar_cambios($1::jsonb) as r', [json({
    clientes: [{ telefono: '+581', hubspot_contact_id: 'c1', hubspot_deal_id: 'd1', etapa: 'nuevo', hubspot_owner_id: '3', alta_completa: true }],
    tareas_nuevas: [{ hubspot_task_id: 't1', telefono: '+581', tipo: 'contestar', vence_at: '2026-09-29T14:15:00Z', hubspot_deal_id: 'd1' }],
  })]);
  assert.deepEqual(r[0].r, { clientes: 1, tareas_nuevas: 1, tareas_actualizadas: 0, traspasos: 0 });
  let c = await cliente(db, '+581');
  assert.deepEqual([c.hubspot_contact_id, c.hubspot_deal_id, c.etapa, c.vendedor_id, c.alta_intentada_at], ['c1', 'd1', 'nuevo', 3, null]);

  await q(db, 'select registrar_cambios($1::jsonb)', [json({
    clientes: [{ telefono: '+581', etapa: 'solicitud', hubspot_owner_id: 'desconocido' }],
    tareas_estado: [{ hubspot_task_id: 't1', estado: 'completada' }],
  })]);
  c = await cliente(db, '+581');
  assert.deepEqual([c.hubspot_deal_id, c.etapa, c.vendedor_id], ['d1', 'solicitud', 3], 'null no pisa; owner desconocido no cambia vendedor');
  const [t] = await q(db, 'select * from tareas');
  assert.equal(t.estado, 'completada');
  assert.ok(t.completada_at);
}));

test('F2 SQL: debounce, candado, lote, últimos 40 mensajes y guardado', opciones, () => conBD(async (db) => {
  await vendedores(db);
  const mensajes = [];
  for (let i = 0; i < 45; i++) mensajes.push(msg(`a${i}`, '+581', i % 2 ? 'saliente' : 'entrante', 100 - i));
  await registrar(db, mensajes);
  await registrar(db, [msg('b1', '+582', 'entrante', 2)]); // muy reciente: debounce
  await registrar(db, [msg('c1', '+583', 'entrante', 30)]); // sin negocio
  await db.query("update clientes set hubspot_deal_id = 'd-' || telefono, vendedor_id = 1 where telefono in ('+581', '+582')");
  await db.query("insert into tareas (hubspot_task_id, telefono, tipo) values ('t1', '+581', 'cotizar')");

  const tomados = await q(db, 'select * from f2_tomar_pendientes(5, 10)');
  assert.deepEqual(tomados.map((t) => t.telefono), ['+581']);
  const [t] = tomados;
  assert.equal(t.mensajes.length, 40);
  assert.equal(t.mensajes[0].texto, 'a5', 'los 40 más recientes, del más antiguo al más reciente');
  assert.equal(t.mensajes[39].texto, 'a44');
  assert.deepEqual(t.tareas_abiertas.map((x) => x.tipo), ['cotizar']);
  assert.equal(t.vendedor_owner_id, '1');
  assert.equal((await q(db, 'select * from f2_tomar_pendientes(5, 10)')).length, 0, 'candado');

  // llega un mensaje mientras se analizaba → queda pendiente
  await registrar(db, [msg('a99', '+581', 'entrante', 0)]);
  await q(db, 'select f2_guardar_resultados($1::jsonb)', [json([{
    telefono: '+581', ok: true, corte: t.corte, etapa: 'cotizado', hubspot_owner_id: '3',
    tareas_nuevas: [{ hubspot_task_id: 't2', tipo: 'seguimiento', vence_at: '2026-10-01T13:00:00Z', hubspot_deal_id: 'd-+581' }],
    analisis: { modo: 'activo', etapa_antes: 'solicitud', etapa_detectada: 'cotizado', confianza: 0.9, etapa_aplicada: 'cotizado', resultado: { a: 1 }, decision: {}, tokens: { input_tokens: 10 } },
  }])]);
  let c = await cliente(db, '+581');
  assert.deepEqual([c.pendiente_analisis, c.etapa, c.vendedor_id, c.analisis_tomado_at], [true, 'cotizado', 3, null]);
  assert.ok(c.ultimo_analisis_at);
  const [a] = await q(db, 'select * from analisis');
  assert.deepEqual([a.modo, a.etapa_detectada, Number(a.confianza), a.tokens.input_tokens], ['activo', 'cotizado', 0.9, 10]);
  assert.equal((await q(db, "select count(*)::int as n from tareas where hubspot_task_id = 't2'"))[0].n, 1);

  // sin mensajes nuevos → deja de estar pendiente
  await db.query("update clientes set ultimo_msg_cliente_at = now() - interval '10 minutes', ultimo_msg_empresa_at = null where telefono = '+581'");
  const [t2] = await q(db, 'select * from f2_tomar_pendientes(5, 10)');
  await q(db, 'select f2_guardar_resultados($1::jsonb)', [json([{ telefono: '+581', ok: true, corte: t2.corte }])]);
  c = await cliente(db, '+581');
  assert.equal(c.pendiente_analisis, false);
}));

test('F2 SQL: fallos, liberar y límite de 5 fallos', opciones, () => conBD(async (db) => {
  await registrar(db, [msg('a', '+581', 'entrante', 10)]);
  await db.query("update clientes set hubspot_deal_id = 'd1'");
  for (let i = 1; i <= 5; i++) {
    await db.query('update clientes set analisis_tomado_at = null');
    const [t] = await q(db, 'select * from f2_tomar_pendientes(5, 10)');
    assert.ok(t, `intento ${i}`);
    await q(db, 'select f2_guardar_resultados($1::jsonb)', [json([{ telefono: '+581', ok: false, corte: t.corte, analisis: { modo: 'sombra', error: 'boom' } }])]);
  }
  let c = await cliente(db, '+581');
  assert.deepEqual([c.pendiente_analisis, c.analisis_fallos], [true, 5]);
  await db.query('update clientes set analisis_tomado_at = null');
  assert.equal((await q(db, 'select * from f2_tomar_pendientes(5, 10)')).length, 0, 'tras 5 fallos no reintenta');
  assert.equal((await q(db, "select f5_datos() as d"))[0].d.clientes_sin_analizar, 1);

  // un mensaje nuevo reinicia el contador
  await registrar(db, [msg('b', '+581', 'entrante', 9)]);
  const [t] = await q(db, 'select * from f2_tomar_pendientes(5, 10)');
  assert.ok(t);
  await q(db, 'select f2_guardar_resultados($1::jsonb)', [json([{ telefono: '+581', liberar: true }])]);
  c = await cliente(db, '+581');
  assert.deepEqual([c.analisis_tomado_at, c.analisis_fallos, c.pendiente_analisis], [null, 0, true]);
  assert.equal((await q(db, 'select count(*)::int as n from analisis'))[0].n, 5);
}));

test('F3, F4 y F5 SQL', opciones, () => conBD(async (db) => {
  await vendedores(db);
  await registrar(db, [msg('a', '+581', 'entrante', 30), msg('b', '+582', 'entrante', 30), msg('c', '+582', 'saliente', 20), msg('d', '+583', 'entrante', 30)]);
  await db.query("update clientes set hubspot_deal_id = 'd' || telefono, vendedor_id = 1 where telefono in ('+581', '+582')");
  await db.query(`insert into tareas (hubspot_task_id, telefono, tipo, vence_at) values
    ('t1', '+582', 'contestar', now() - interval '1 hour'), ('t2', '+581', 'cotizar', now() - interval '2 hours'),
    ('t3', '+581', 'seguimiento', now() + interval '1 day')`);

  const f3 = await q(db, 'select * from f3_estado() order by telefono');
  assert.deepEqual(f3.map((r) => [r.telefono, r.sin_respuesta, r.tareas_contestar.length]), [['+581', true, 0], ['+582', false, 1]]);
  assert.equal(f3[0].vendedor_nombre, 'Ana');

  const f4 = await q(db, 'select * from f4_tareas_abiertas()');
  assert.equal(f4.length, 3);
  assert.equal(f4[0].vendedor_owner_id, '1');

  const [{ d }] = await q(db, 'select f5_datos() as d');
  assert.deepEqual(d.sin_responder.map((s) => [s.telefono, s.vendedor_owner_id]), [['+581', '1']]);
  assert.deepEqual(d.tareas_vencidas.map((t) => t.hubspot_task_id).sort(), ['t1', 't2']);
  assert.deepEqual(d.tareas_abiertas.map((t) => t.hubspot_task_id).sort(), ['t1', 't2', 't3']);
  assert.deepEqual(d.vendedores, [{ nombre: 'Ana', hubspot_owner_id: '1' }, { nombre: 'Caro', hubspot_owner_id: '3' }]);
}));

test('Cada tarea cuenta para su propietario en el resumen diario', opciones, () => conBD(async (db) => {
  await vendedores(db);
  await registrar(db, [msg('a', '+581', 'entrante', 30)]);
  await db.query("update clientes set hubspot_deal_id = 'd1', vendedor_id = 1 where telefono = '+581'");
  await q(db, 'select registrar_cambios($1::jsonb)', [json({
    tareas_nuevas: [
      // producción asignada a Caro aunque el cliente es de Ana
      { hubspot_task_id: 'p1', telefono: '+581', tipo: 'produccion', vence_at: new Date(Date.now() - 3600000).toISOString(), hubspot_deal_id: 'd1', hubspot_owner_id: '3' },
      // sin propietario guardado → cuenta para el vendedor del cliente
      { hubspot_task_id: 'e1', telefono: '+581', tipo: 'enviar', vence_at: new Date(Date.now() + 3600000).toISOString(), hubspot_deal_id: 'd1' },
    ],
  })]);
  assert.deepEqual(
    (await q(db, 'select hubspot_task_id, hubspot_owner_id from tareas order by hubspot_task_id')).map((t) => [t.hubspot_task_id, t.hubspot_owner_id]),
    [['e1', null], ['p1', '3']],
  );
  const [{ d }] = await q(db, 'select f5_datos() as d');
  assert.deepEqual(d.tareas_vencidas.map((t) => [t.hubspot_task_id, t.vendedor, t.vendedor_owner_id]), [['p1', 'Caro', '3']]);
  assert.deepEqual(
    d.tareas_abiertas.map((t) => [t.hubspot_task_id, t.vendedor, t.vendedor_owner_id]),
    [['p1', 'Caro', '3'], ['e1', 'Ana', '1']],
  );
}));

// ── Punta a punta ───────────────────────────────────────────────────────────

// Ejecuta F1 igual que el flujo de n8n: Code → Postgres → Code → Postgres...
async function correrF1(db, ctx, body) {
  const [normalizado] = await f1.normalizar([{ headers: { 'x-webhook-secret': ctx.env.D360_WEBHOOK_SECRET }, body }], ctx);
  if (!normalizado) return;
  const filas = await registrar(db, normalizado.mensajes);
  const busqueda = await f1.buscarEnHubspot(filas, ctx);
  if (busqueda.length) {
    const asignados = await asignar(db, busqueda[0].asignaciones);
    const [{ cambios }] = await f1.crearEnHubspot(asignados, ctx, { busquedas: busqueda[0].busquedas });
    await q(db, 'select registrar_cambios($1::jsonb)', [json(cambios)]);
  }
  const respondidas = await f1.completarRespondidas(filas, ctx);
  if (respondidas.length) await q(db, 'select registrar_cambios($1::jsonb)', [json(respondidas[0].cambios)]);
}

function payload(tipo, id, minutosAtras, texto) {
  const timestamp = String(Math.floor((Date.now() - minutosAtras * 60000) / 1000));
  if (tipo === 'entrante') {
    return {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: {
        contacts: [{ profile: { name: 'Luis' }, wa_id: '584141234567' }],
        messages: [{ from: '584141234567', id, timestamp, type: 'text', text: { body: texto } }],
      } }] }],
    };
  }
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'smb_message_echoes', value: {
      message_echoes: [{ from: '582125550000', to: '584141234567', id, timestamp, type: 'text', text: { body: texto } }],
    } }] }],
  };
}

test('punta a punta: mensaje → alta con rotación → respuesta desde la app → F2 activo → F4', opciones, () => conBD(async (db) => {
  await vendedores(db);
  // Reloj fijo en horario laboral para las fechas límite; los mensajes usan la hora real.
  const env = envPrueba({ MODO_SOMBRA: 'false', HORARIO_LABORAL: 'lun-dom 00:00-24:00' });
  const { ctx, hubspot, claude } = crearCtx({ env, ahora: new Date() });

  await correrF1(db, ctx, payload('entrante', 'wamid.1', 20, 'Hola, necesito 100 franelas'));
  await correrF1(db, ctx, payload('entrante', 'wamid.1', 20, 'Hola, necesito 100 franelas')); // reintento de Meta
  await correrF1(db, ctx, payload('entrante', 'wamid.2', 19, '¿Tienen en azul?'));
  assert.equal(Object.keys(hubspot.datos.deals).length, 1, 'un solo negocio');
  assert.equal(hubspot.tareas().length, 1, 'una sola tarea contestar');
  let c = await cliente(db, '+584141234567');
  assert.equal(c.vendedor_id, 1);
  const [deal] = Object.values(hubspot.datos.deals);
  assert.equal(c.hubspot_deal_id, deal.id);

  await correrF1(db, ctx, payload('saliente', 'wamid.3', 15, 'Hola Luis, sí hay en azul. Te preparo la cotización.'));
  const [contestar] = hubspot.tareas();
  assert.equal(contestar.properties.hs_task_status, 'COMPLETED');
  assert.equal((await q(db, "select estado from tareas where tipo = 'contestar'"))[0].estado, 'completada');

  // F2
  claude.responder(analisis({
    etapa_detectada: 'solicitud', confianza: 0.95, motivo: 'Pidió "100 franelas"',
    datos_pedido: { producto: 'franelas azules', cantidad: 100, fecha_entrega: null, empresa_cliente: null },
  }));
  const pendientes = await q(db, 'select * from f2_tomar_pendientes(5, 10)');
  const [{ resultados }] = await f2.analizar(pendientes, ctx);
  await q(db, 'select f2_guardar_resultados($1::jsonb)', [json(resultados)]);
  c = await cliente(db, '+584141234567');
  assert.deepEqual([c.etapa, c.pendiente_analisis], ['solicitud', false]);
  assert.equal(deal.properties.dealstage, ETAPAS_IDS.solicitud);
  const cotizar = hubspot.tareas().find((t) => t.properties.hs_task_subject.startsWith('Enviar cotización'));
  assert.equal(cotizar.properties.hs_task_subject, 'Enviar cotización a Luis: franelas azules x 100');
  assert.match(claude.solicitudes[0].messages[0].content, /VENDEDOR: Hola Luis, sí hay en azul/);

  // Paso a verificar pago a mano + tarea, y F4 al completarla
  deal.properties.dealstage = ETAPAS_IDS.verificar_pago;
  const verificar = hubspot.agregar('tasks', { hs_task_status: 'COMPLETED' });
  await db.query("insert into tareas (hubspot_task_id, telefono, tipo, hubspot_deal_id) values ($1, '+584141234567', 'verificar_pago', $2)", [verificar.id, deal.id]);
  const abiertas = await q(db, 'select * from f4_tareas_abiertas()');
  const salida = await f4.procesar(abiertas, ctx);
  await q(db, 'select registrar_cambios($1::jsonb)', [json(salida[0].cambios)]);
  assert.equal(deal.properties.dealstage, ETAPAS_IDS.pagado);
  c = await cliente(db, '+584141234567');
  assert.equal(c.etapa, 'pagado');
  const tareasBd = await q(db, "select tipo, estado from tareas order by creada_at, tipo");
  assert.deepEqual(tareasBd.map((t) => `${t.tipo}:${t.estado}`).sort(), [
    'contestar:completada', 'cotizar:abierta', 'produccion:abierta', 'verificar_pago:completada',
  ]);
}));

test('punta a punta: traspaso de un cliente de Ana a Caro', opciones, () => conBD(async (db) => {
  await vendedores(db);
  const env = envPrueba({ HORARIO_LABORAL: 'lun-dom 00:00-24:00' });
  const { ctx, hubspot } = crearCtx({ env, ahora: new Date() });
  await correrF1(db, ctx, payload('entrante', 'wamid.t1', 10, 'Hola, quiero 50 gorras'));
  let c = await cliente(db, '+584141234567');
  assert.deepEqual([c.vendedor_id, c.hubspot_owner_visto], [1, '1'], 'el alta anota el propietario: no es un traspaso');
  const [deal] = Object.values(hubspot.datos.deals);
  const [contestar] = hubspot.tareas();

  const revisar = async () => {
    const [salida] = await traspasos.revisar(await q(db, 'select * from f4_clientes_abiertos()'), ctx);
    if (salida) await q(db, 'select registrar_cambios($1::jsonb)', [json(salida.cambios)]);
    return salida;
  };
  assert.equal(await revisar(), undefined, 'sin cambios no pasa nada');

  // Ana le pasa el cliente a Caro en HubSpot
  deal.properties.hubspot_owner_id = '3';
  await revisar();
  c = await cliente(db, '+584141234567');
  assert.deepEqual([c.vendedor_id, c.hubspot_owner_visto], [3, '3']);
  assert.equal(contestar.properties.hubspot_owner_id, '3');
  assert.equal((await q(db, "select hubspot_owner_id from tareas where tipo = 'contestar'"))[0].hubspot_owner_id, '3');
  const [t] = await q(db, 'select * from traspasos');
  assert.deepEqual([t.de_owner_id, t.a_owner_id, t.de_nombre, t.a_nombre, t.tareas_movidas], ['1', '3', 'Ana Pérez', 'usuario 3', 1]);
  assert.ok(hubspot.tareas().some((x) => x.properties.hs_task_subject === 'Cliente transferido: Luis (antes de Ana Pérez)'));

  // No se repite en la siguiente corrida, y aparece en el resumen del administrador
  assert.equal(await revisar(), undefined);
  assert.equal((await q(db, 'select count(*)::int as n from traspasos'))[0].n, 1);
  const [{ d }] = await q(db, 'select f5_datos() as d');
  assert.deepEqual(d.traspasos.map((x) => [x.nombre, x.de, x.a, x.tareas_movidas]), [['Luis', 'Ana Pérez', 'usuario 3', 1]]);
  assert.deepEqual(d.tareas_abiertas.map((x) => [x.tipo, x.vendedor, x.vendedor_owner_id]), [['contestar', 'Caro', '3']]);

  // Los negocios cerrados no se revisan
  await db.query("update clientes set etapa = 'perdido'");
  assert.equal((await q(db, 'select * from f4_clientes_abiertos()')).length, 0);
}));
