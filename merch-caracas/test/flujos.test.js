'use strict';

// Pasos de F1–F5 contra HubSpot y Claude simulados. Las filas de entrada imitan
// lo que devuelven las funciones de Postgres (probadas aparte en sql.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const f1 = require('../src/flujos/f1');
const f2 = require('../src/flujos/f2');
const f3 = require('../src/flujos/f3');
const f4 = require('../src/flujos/f4');
const f5 = require('../src/flujos/f5');
const { crearCtx, envPrueba, analisis, ETAPAS_IDS } = require('./apoyo/falsos');

const TEL = '+584141234567';
const MARTES_10AM = new Date('2026-09-29T14:00:00Z');
const webhook = (nombre, secreto = 'secreto-de-prueba-123456789') => ({
  headers: { 'x-webhook-secret': secreto },
  query: {},
  body: require(`./fixtures/${nombre}.json`),
});

// ── F1 ──────────────────────────────────────────────────────────────────────

test('F1 normalizar: valida el secreto y agrupa los mensajes en un item', async () => {
  const { ctx } = crearCtx();
  const [item] = await f1.normalizar([webhook('mensaje-texto')], ctx);
  assert.equal(item.mensajes.length, 1);
  assert.deepEqual(await f1.normalizar([webhook('estados')], ctx), []);
  await assert.rejects(f1.normalizar([webhook('mensaje-texto', 'otro')], ctx), /secreto no coincide/);
});

test('F1 alta de cliente nuevo: contacto + negocio en Nuevo + tarea Contestar', async () => {
  const { ctx, hubspot } = crearCtx({ ahora: MARTES_10AM });
  const filas = [{ telefono: TEL, nombre_wa: 'Luis Rojas', necesita_alta: true, tareas_contestar_completar: [] }];

  const [busqueda] = await f1.buscarEnHubspot(filas, ctx);
  assert.deepEqual(busqueda.asignaciones, [{ telefono: TEL, hubspot_owner_id: null }]);

  const asignados = [{ telefono: TEL, vendedor_id: 1, hubspot_owner_id: '1', vendedor_nombre: 'Ana', metodo: 'rotacion' }];
  const [{ cambios }] = await f1.crearEnHubspot(asignados, ctx, { busquedas: busqueda.busquedas });

  const [contacto] = Object.values(hubspot.datos.contacts);
  assert.deepEqual(contacto.properties.phone, TEL);
  assert.equal(contacto.properties.firstname, 'Luis Rojas');
  assert.equal(contacto.properties.hubspot_owner_id, '1');

  const [negocio] = Object.values(hubspot.datos.deals);
  assert.equal(negocio.properties.dealname, 'Luis Rojas (WhatsApp)');
  assert.equal(negocio.properties.pipeline, 'p1');
  assert.equal(negocio.properties.dealstage, ETAPAS_IDS.nuevo);
  assert.equal(negocio.properties.hubspot_owner_id, '1');
  assert.equal(negocio.properties.wa_telefono, TEL);
  assert.deepEqual(negocio.asociados.contacts, [contacto.id]);

  const [tarea] = hubspot.tareas();
  assert.equal(tarea.properties.hs_task_subject, 'Contestar a Luis Rojas');
  assert.equal(tarea.properties.hubspot_owner_id, '1');
  assert.equal(tarea.properties.hs_timestamp, '2026-09-29T14:15:00.000Z'); // 15 min laborables
  assert.equal(tarea.properties.hs_task_priority, 'HIGH');
  assert.deepEqual(tarea.asociados, { deals: [negocio.id], contacts: [contacto.id] });

  assert.deepEqual(cambios.clientes, [{
    telefono: TEL, hubspot_contact_id: contacto.id, hubspot_deal_id: negocio.id, etapa: 'nuevo', hubspot_owner_id: '1', alta_completa: true,
  }]);
  assert.deepEqual(cambios.tareas_nuevas, [{
    hubspot_task_id: tarea.id, telefono: TEL, tipo: 'contestar', vence_at: '2026-09-29T14:15:00.000Z', hubspot_deal_id: negocio.id,
  }]);
});

test('F1 cliente que vuelve: reusa el propietario y el negocio abierto de HubSpot', async () => {
  const { ctx, hubspot } = crearCtx({ ahora: MARTES_10AM });
  const contacto = hubspot.agregar('contacts', { phone: '0414-1234567', hubspot_owner_id: '2' });
  const negocio = hubspot.agregar('deals', { pipeline: 'p1', dealstage: ETAPAS_IDS.cotizado, hubspot_owner_id: '2' }, { contacts: [contacto.id] });

  const [b] = await f1.buscarEnHubspot([{ telefono: TEL, nombre_wa: 'Luis', necesita_alta: true }], ctx);
  assert.deepEqual(b.asignaciones, [{ telefono: TEL, hubspot_owner_id: '2' }]);
  assert.equal(b.busquedas[TEL].contacto_id, contacto.id);
  assert.equal(b.busquedas[TEL].negocio_abierto_id, negocio.id);

  const [{ cambios }] = await f1.crearEnHubspot(
    [{ telefono: TEL, hubspot_owner_id: '2', vendedor_nombre: 'Beto', metodo: 'hubspot' }], ctx, { busquedas: b.busquedas },
  );
  assert.equal(Object.keys(hubspot.datos.deals).length, 1, 'no crea negocio nuevo');
  assert.equal(Object.keys(hubspot.datos.contacts).length, 1, 'no crea contacto nuevo');
  assert.equal(negocio.properties.wa_telefono, TEL, 'le pone el teléfono al negocio encontrado por el contacto');
  assert.equal(negocio.properties.hubspot_owner_id, '2', 'mantiene el propietario');
  assert.equal(cambios.clientes[0].etapa, 'cotizado');
  assert.equal(cambios.clientes[0].hubspot_deal_id, negocio.id);
});

test('F1 cliente con negocio cerrado: negocio nuevo con el mismo propietario', async () => {
  const { ctx, hubspot } = crearCtx({ ahora: MARTES_10AM });
  hubspot.agregar('deals', { pipeline: 'p1', dealstage: ETAPAS_IDS.entregado, hubspot_owner_id: '2', wa_telefono: TEL });
  const [b] = await f1.buscarEnHubspot([{ telefono: TEL, nombre_wa: 'Luis', necesita_alta: true }], ctx);
  assert.equal(b.asignaciones[0].hubspot_owner_id, '2');
  assert.equal(b.busquedas[TEL].negocio_abierto_id, null);
  await f1.crearEnHubspot([{ telefono: TEL, hubspot_owner_id: '2', vendedor_nombre: 'Beto', metodo: 'hubspot' }], ctx, { busquedas: b.busquedas });
  const negocios = Object.values(hubspot.datos.deals);
  assert.equal(negocios.length, 2);
  assert.equal(negocios[1].properties.dealstage, ETAPAS_IDS.nuevo);
  assert.equal(negocios[1].properties.hubspot_owner_id, '2');
});

test('F1 sin HORARIO_LABORAL falla antes de tocar HubSpot', async () => {
  const { ctx, hubspot } = crearCtx({ env: envPrueba({ HORARIO_LABORAL: '' }) });
  await assert.rejects(f1.buscarEnHubspot([{ telefono: TEL, necesita_alta: true }], ctx), /HORARIO_LABORAL/);
  assert.equal(hubspot.llamadas.length, 0);
});

test('F1 respuesta desde la app completa la tarea Contestar', async () => {
  const { ctx, hubspot } = crearCtx();
  const t = hubspot.agregar('tasks', { hs_task_status: 'NOT_STARTED' });
  const [{ cambios }] = await f1.completarRespondidas(
    [{ telefono: TEL, tareas_contestar_completar: [t.id, '999999'] }, { telefono: '+58412', tareas_contestar_completar: [] }], ctx,
  );
  assert.equal(hubspot.datos.tasks[t.id].properties.hs_task_status, 'COMPLETED');
  assert.deepEqual(cambios.tareas_estado, [
    { hubspot_task_id: t.id, estado: 'completada' },
    { hubspot_task_id: '999999', estado: 'eliminada' },
  ]);
  assert.deepEqual(await f1.completarRespondidas([{ tareas_contestar_completar: [] }], ctx), []);
});

// ── F2 ──────────────────────────────────────────────────────────────────────

function filaF2(hubspot, etapa = 'nuevo', extra = {}) {
  const negocio = hubspot.agregar('deals', { pipeline: 'p1', dealstage: ETAPAS_IDS[etapa], hubspot_owner_id: '1', dealname: 'Luis (WhatsApp)' });
  return {
    telefono: TEL,
    nombre_wa: 'Luis',
    hubspot_deal_id: negocio.id,
    hubspot_contact_id: 'c1',
    etapa,
    vendedor_owner_id: '1',
    ultimo_msg_cliente_at: '2026-09-29T12:00:00Z',
    ultimo_msg_empresa_at: '2026-09-29T13:00:00Z',
    corte: '2026-09-29T13:00:00Z',
    mensajes: [
      { direccion: 'entrante', tipo: 'text', texto: 'Necesito 200 termos con logo', ts: '2026-09-29T12:00:00Z' },
      { direccion: 'saliente', tipo: 'document', texto: '[documento: cotizacion.pdf]', ts: '2026-09-29T13:00:00Z' },
    ],
    tareas_abiertas: [],
    ...extra,
  };
}

test('F2 modo sombra: solo resumen_ia + nota, no mueve etapa ni crea tareas', async () => {
  const { ctx, hubspot, claude } = crearCtx({ ahora: MARTES_10AM });
  const fila = filaF2(hubspot);
  claude.responder(analisis({
    etapa_detectada: 'cotizado', confianza: 0.9, motivo: 'El vendedor envió "cotizacion.pdf".',
    datos_pedido: { producto: 'termos con logo', cantidad: 200, fecha_entrega: null, empresa_cliente: null },
    resumen: 'Se envió la cotización de 200 termos.',
  }));
  const [{ resultados }] = await f2.analizar([fila], ctx);
  const negocio = hubspot.datos.deals[fila.hubspot_deal_id];
  assert.equal(negocio.properties.dealstage, ETAPAS_IDS.nuevo);
  assert.equal(negocio.properties.resumen_ia, 'Se envió la cotización de 200 termos.');
  assert.equal(negocio.properties.producto, undefined);
  assert.equal(hubspot.tareas().length, 0);
  const [nota] = hubspot.notas();
  assert.match(nota.properties.hs_note_body, /modo sombra/);
  assert.match(nota.properties.hs_note_body, /Habría movido el negocio de <b>Nuevo<\/b> a <b>Cotizado<\/b>/);
  assert.match(nota.properties.hs_note_body, /Seguimiento de cotización a Luis/);
  assert.match(nota.properties.hs_note_body, /&quot;cotizacion.pdf&quot;/);

  const [r] = resultados;
  assert.equal(r.ok, true);
  assert.equal(r.etapa, 'nuevo');
  assert.deepEqual(r.tareas_nuevas, []);
  assert.equal(r.analisis.modo, 'sombra');
  assert.equal(r.analisis.etapa_detectada, 'cotizado');
  assert.equal(r.analisis.etapa_aplicada, null);
  assert.equal(r.analisis.tokens.modelo, 'claude-sonnet-5-5');

  // El contexto que recibió Claude
  const enviado = claude.solicitudes[0].messages[0].content;
  assert.match(enviado, /Etapa actual del negocio: nuevo/);
  assert.match(enviado, /CLIENTE: Necesito 200 termos con logo/);
});

test('F2 modo activo: mueve etapa, escribe propiedades, crea tarea con vencimiento y nota', async () => {
  const { ctx, hubspot, claude } = crearCtx({ env: envPrueba({ MODO_SOMBRA: 'false' }), ahora: MARTES_10AM });
  const fila = filaF2(hubspot, 'solicitud');
  claude.responder(analisis({
    etapa_detectada: 'cotizado', confianza: 0.92, motivo: 'Se envió cotizacion.pdf',
    datos_pedido: { producto: 'termos con logo', cantidad: 200, fecha_entrega: '2026-12-01', empresa_cliente: 'Acme' },
    tareas_nuevas: [{ tipo: 'contestar', titulo: 'Contestar a Luis sobre colores', detalle: 'Preguntó si hay en negro' }],
  }));
  const [{ resultados: [r] }] = await f2.analizar([fila], ctx);
  const p = hubspot.datos.deals[fila.hubspot_deal_id].properties;
  assert.equal(p.dealstage, ETAPAS_IDS.cotizado);
  assert.equal(p.producto, 'termos con logo');
  assert.equal(p.cantidad, 200);
  assert.equal(p.fecha_entrega, '2026-12-01');
  assert.equal(p.empresa_cliente, 'Acme');

  const tareas = hubspot.tareas().map((t) => [t.properties.hs_task_subject, t.properties.hs_timestamp, t.properties.hubspot_owner_id]);
  assert.deepEqual(tareas, [
    ['Seguimiento de cotización a Luis', '2026-10-01T13:00:00.000Z', '1'], // 48 h desde el envío
    ['Contestar a Luis sobre colores', '2026-09-29T14:15:00.000Z', '1'],
  ]);
  assert.equal(hubspot.notas().length, 1);
  assert.equal(r.etapa, 'cotizado');
  assert.equal(r.analisis.etapa_aplicada, 'cotizado');
  assert.deepEqual(r.tareas_nuevas.map((t) => t.tipo), ['seguimiento', 'contestar']);
});

test('F2 activo: no pisa una etapa posterior movida a mano', async () => {
  const { ctx, hubspot, claude } = crearCtx({ env: envPrueba({ MODO_SOMBRA: 'false' }), ahora: MARTES_10AM });
  const fila = filaF2(hubspot, 'nuevo');
  // alguien lo movió a mano a Pagado después de que se guardó "nuevo" en Postgres
  hubspot.datos.deals[fila.hubspot_deal_id].properties.dealstage = ETAPAS_IDS.pagado;
  claude.responder(analisis({ etapa_detectada: 'cotizado' }));
  const [{ resultados: [r] }] = await f2.analizar([fila], ctx);
  assert.equal(hubspot.datos.deals[fila.hubspot_deal_id].properties.dealstage, ETAPAS_IDS.pagado);
  assert.equal(r.etapa, 'pagado');
  assert.equal(hubspot.notas().length, 0, 'sin cambios no deja nota en modo activo');
});

test('F2 activo: negocio cerrado + pedido nuevo abre otro negocio', async () => {
  const { ctx, hubspot, claude } = crearCtx({ env: envPrueba({ MODO_SOMBRA: 'false' }), ahora: MARTES_10AM });
  const fila = filaF2(hubspot, 'entregado');
  claude.responder(analisis({ etapa_detectada: 'solicitud', datos_pedido: { producto: 'gorras', cantidad: 50, fecha_entrega: null, empresa_cliente: null } }));
  const [{ resultados: [r] }] = await f2.analizar([fila], ctx);
  const negocios = Object.values(hubspot.datos.deals);
  assert.equal(negocios.length, 2);
  assert.equal(negocios[0].properties.dealstage, ETAPAS_IDS.entregado);
  assert.equal(negocios[1].properties.dealstage, ETAPAS_IDS.solicitud);
  assert.equal(negocios[1].properties.producto, 'gorras');
  assert.equal(negocios[1].properties.wa_telefono, TEL);
  assert.equal(r.hubspot_deal_id, negocios[1].id);
  assert.equal(r.etapa, 'solicitud');
  assert.equal(hubspot.tareas()[0].properties.hs_task_subject, 'Enviar cotización a Luis: gorras x 50');
});

test('F2 errores: negocio borrado, fallo de Claude y fallo parcial', async () => {
  const { ctx, hubspot, claude } = crearCtx({ env: envPrueba({ MODO_SOMBRA: 'false' }), ahora: MARTES_10AM });
  const borrado = { ...filaF2(hubspot), hubspot_deal_id: '424242' };
  const conError = filaF2(hubspot, 'nuevo', { telefono: '+584149999999' });
  const parcial = filaF2(hubspot, 'cotizado', { telefono: '+584148888888' });
  claude.responderError(400, { error: { type: 'invalid_request_error', message: 'mal' } });
  claude.responder(analisis({ etapa_detectada: 'verificar_pago' }));
  // la tarea se crea, pero el PATCH del negocio falla (4 veces: agota reintentos)
  hubspot.fallar('PATCH', new RegExp(`/deals/${parcial.hubspot_deal_id}$`), 500, 4);

  const [{ resultados }] = await f2.analizar([borrado, conError, parcial], ctx);
  assert.deepEqual(resultados.map((r) => [r.telefono, r.ok]), [[TEL, true], ['+584149999999', false], ['+584148888888', false]]);
  assert.equal(resultados[0].limpiar_deal, true);
  assert.match(resultados[1].analisis.error, /400/);
  assert.match(resultados[2].analisis.error, /500/);
  assert.deepEqual(resultados[2].tareas_nuevas.map((t) => t.tipo), ['verificar_pago'], 'la tarea creada no se pierde');
});

// ── F3 ──────────────────────────────────────────────────────────────────────

function filaF3(hubspot, extra = {}) {
  const negocio = hubspot.agregar('deals', { pipeline: 'p1', dealstage: ETAPAS_IDS.solicitud, hubspot_owner_id: '1' });
  return {
    telefono: TEL, nombre_wa: 'Luis', hubspot_deal_id: negocio.id, hubspot_contact_id: 'c1', etapa: 'solicitud',
    vendedor_owner_id: '1', vendedor_nombre: 'Ana', ultimo_msg_cliente_at: '2026-09-29T12:00:00Z',
    ultimo_msg_empresa_at: '2026-09-29T11:00:00Z', sin_respuesta: true, tareas_contestar: [], ...extra,
  };
}

test('F3 fuera de horario no hace nada', async () => {
  const { ctx, hubspot } = crearCtx({ ahora: new Date('2026-09-30T02:00:00Z') }); // 22:00
  assert.deepEqual(await f3.revisar([filaF3(hubspot)], ctx), []);
});

test('F3 SLA vencido → tarea Contestar que vence ya', async () => {
  const ahora = new Date('2026-09-29T14:01:00Z'); // 121 min laborables después
  const { ctx, hubspot } = crearCtx({ ahora });
  const [{ cambios }] = await f3.revisar([filaF3(hubspot)], ctx);
  const [t] = hubspot.tareas();
  assert.equal(t.properties.hs_task_subject, 'Contestar a Luis');
  assert.equal(t.properties.hs_timestamp, ahora.toISOString());
  assert.match(t.properties.hs_task_body, /hace 121 min laborables/);
  assert.equal(cambios.tareas_nuevas.length, 1);
});

test('F3 dentro del SLA o con tarea abierta no crea otra', async () => {
  const { ctx, hubspot } = crearCtx({ ahora: new Date('2026-09-29T13:30:00Z') }); // 90 min
  await f3.revisar([filaF3(hubspot)], ctx);
  assert.equal(hubspot.tareas().length, 0);

  const otro = crearCtx({ ahora: new Date('2026-09-29T16:00:00Z') });
  await f3.revisar([filaF3(otro.hubspot, {
    tareas_contestar: [{ hubspot_task_id: 't1', vence_at: '2026-09-29T15:30:00Z', escalada_at: null }],
  })], otro.ctx);
  assert.equal(otro.hubspot.tareas().length, 0);
});

test('F3 en etapa Nuevo usa el SLA de 15 min', async () => {
  const { ctx, hubspot } = crearCtx({ ahora: new Date('2026-09-29T12:20:00Z') });
  const fila = filaF3(hubspot, { etapa: 'nuevo' });
  hubspot.datos.deals[fila.hubspot_deal_id].properties.dealstage = ETAPAS_IDS.nuevo;
  await f3.revisar([fila], ctx);
  assert.equal(hubspot.tareas().length, 1);
});

test('F3 escala una tarea vencida hace más de ESCALAR_MIN: nota + tarea al admin, una sola vez', async () => {
  const ahora = new Date('2026-09-29T15:05:00Z');
  const { ctx, hubspot } = crearCtx({ ahora });
  const tarea = { hubspot_task_id: 't1', vence_at: '2026-09-29T14:00:00Z', escalada_at: null }; // 65 min vencida
  const [{ cambios }] = await f3.revisar([filaF3(hubspot, { tareas_contestar: [tarea] })], ctx);
  const [admin] = hubspot.tareas();
  assert.equal(admin.properties.hubspot_owner_id, '900');
  assert.equal(admin.properties.hs_task_subject, 'Escalado: Ana no ha contestado a Luis');
  assert.match(hubspot.notas()[0].properties.hs_note_body, /Escalado/);
  assert.deepEqual(cambios.tareas_estado, [{ hubspot_task_id: 't1', escalada_at: ahora.toISOString() }]);

  const otra = crearCtx({ ahora });
  await f3.revisar([filaF3(otra.hubspot, { tareas_contestar: [{ ...tarea, escalada_at: '2026-09-29T15:00:00Z' }] })], otra.ctx);
  assert.equal(otra.hubspot.tareas().length, 0);
});

test('F3 completa tareas Contestar de clientes ya respondidos y salta spam', async () => {
  const { ctx, hubspot } = crearCtx({ ahora: MARTES_10AM });
  const t = hubspot.agregar('tasks', { hs_task_status: 'NOT_STARTED' });
  const respondido = filaF3(hubspot, { sin_respuesta: false, tareas_contestar: [{ hubspot_task_id: t.id }] });
  const spam = filaF3(hubspot, { telefono: '+584140000000' });
  Object.assign(hubspot.datos.deals[spam.hubspot_deal_id].properties, {
    dealstage: ETAPAS_IDS.perdido, motivo_perdida: 'No era cliente (spam/equivocado)',
  });
  const [{ cambios }] = await f3.revisar([respondido, spam], ctx);
  assert.equal(hubspot.datos.tasks[t.id].properties.hs_task_status, 'COMPLETED');
  assert.equal(hubspot.tareas().length, 1, 'no crea tarea para el spam');
  assert.deepEqual(cambios.clientes.map((c) => c.etapa), ['solicitud', 'perdido']);
});

// ── F4 ──────────────────────────────────────────────────────────────────────

function preparaF4(etapa, tipo) {
  const { ctx, hubspot } = crearCtx({ ahora: MARTES_10AM });
  const negocio = hubspot.agregar('deals', {
    pipeline: 'p1', dealstage: ETAPAS_IDS[etapa], hubspot_owner_id: '1', fecha_entrega: '2026-10-10',
  });
  const tarea = hubspot.agregar('tasks', { hs_task_status: 'NOT_STARTED' });
  const fila = {
    hubspot_task_id: tarea.id, tipo, telefono: TEL, tarea_deal_id: negocio.id, nombre_wa: 'Luis',
    hubspot_contact_id: 'c1', hubspot_deal_id: negocio.id, etapa, vendedor_owner_id: '1',
  };
  return { ctx, hubspot, negocio, tarea, fila };
}

test('F4 Verificar pago completada → Pagado / En producción + tarea de producción', async () => {
  const { ctx, hubspot, negocio, tarea, fila } = preparaF4('verificar_pago', 'verificar_pago');
  hubspot.completarTarea(tarea.id);
  const [{ cambios }] = await f4.procesar([fila], ctx);
  assert.equal(hubspot.datos.deals[negocio.id].properties.dealstage, ETAPAS_IDS.pagado);
  const nueva = hubspot.tareas().find((t) => t.id !== tarea.id);
  assert.equal(nueva.properties.hs_task_subject, 'Iniciar producción del pedido de Luis');
  assert.equal(cambios.tareas_estado[0].estado, 'completada');
  assert.deepEqual(cambios.clientes, [{ telefono: TEL, etapa: 'pagado', hubspot_owner_id: '1' }]);
  assert.equal(cambios.tareas_nuevas[0].tipo, 'produccion');
});

test('F4 cadena completa: producción → listo, enviar → enviado, confirmar → entregado', async () => {
  const casos = [
    ['pagado', 'produccion', 'listo_para_enviar', 'Enviar pedido a Luis', '2026-10-09T13:00:00.000Z'],
    ['listo_para_enviar', 'enviar', 'enviado', 'Confirmar recepción con Luis', '2026-10-01T14:00:00.000Z'],
    ['enviado', 'confirmar', 'entregado', null, null],
  ];
  for (const [desde, tipo, hasta, titulo, vence] of casos) {
    const { ctx, hubspot, negocio, tarea, fila } = preparaF4(desde, tipo);
    hubspot.completarTarea(tarea.id);
    await f4.procesar([fila], ctx);
    assert.equal(hubspot.datos.deals[negocio.id].properties.dealstage, ETAPAS_IDS[hasta], tipo);
    const nueva = hubspot.tareas().find((t) => t.id !== tarea.id);
    assert.equal(nueva ? nueva.properties.hs_task_subject : null, titulo, tipo);
    if (vence) assert.equal(nueva.properties.hs_timestamp, vence, tipo);
  }
});

test('F4 no retrocede un negocio que ya está más adelante', async () => {
  const { ctx, hubspot, negocio, tarea, fila } = preparaF4('enviado', 'verificar_pago');
  hubspot.completarTarea(tarea.id);
  await f4.procesar([fila], ctx);
  assert.equal(hubspot.datos.deals[negocio.id].properties.dealstage, ETAPAS_IDS.enviado);
  assert.equal(hubspot.tareas().length, 1);
});

test('F4 tareas abiertas, eliminadas y tipos que no mueven etapa', async () => {
  const { ctx, hubspot, negocio, tarea, fila } = preparaF4('solicitud', 'cotizar');
  hubspot.completarTarea(tarea.id);
  const abierta = { ...fila, hubspot_task_id: hubspot.agregar('tasks', { hs_task_status: 'NOT_STARTED' }).id, tipo: 'contestar' };
  const borrada = { ...fila, hubspot_task_id: '777', tipo: 'seguimiento' };
  const [{ cambios }] = await f4.procesar([fila, abierta, borrada], ctx);
  assert.equal(hubspot.datos.deals[negocio.id].properties.dealstage, ETAPAS_IDS.solicitud);
  assert.deepEqual(cambios.tareas_estado.map((t) => [t.hubspot_task_id, t.estado]), [[tarea.id, 'completada'], ['777', 'eliminada']]);

  const nada = crearCtx();
  const t = nada.hubspot.agregar('tasks', { hs_task_status: 'NOT_STARTED' });
  assert.deepEqual(await f4.procesar([{ ...fila, hubspot_task_id: t.id }], nada.ctx), []);
});

// ── F5 ──────────────────────────────────────────────────────────────────────

test('F5 resumen diario como tarea para el administrador', async () => {
  const { ctx, hubspot } = crearCtx({ ahora: new Date('2026-09-30T11:30:00Z') });
  hubspot.agregar('deals', { pipeline: 'p1', dealstage: ETAPAS_IDS.cotizado, dealname: 'Luis (WhatsApp)', hubspot_owner_id: '1', producto: 'termos', cantidad: '200' });
  hubspot.agregar('deals', { pipeline: 'p1', dealstage: ETAPAS_IDS.perdido, dealname: 'Ana (WhatsApp)', hubspot_owner_id: '2', motivo_perdida: 'Precio fuera de presupuesto' });
  const datos = {
    sin_responder: [{ telefono: TEL, nombre: 'Luis', etapa: 'cotizado', vendedor: 'Ana', desde: '2026-09-29T20:00:00Z' }],
    tareas_vencidas: [
      { tipo: 'cotizar', nombre: 'Luis', vendedor: 'Ana' },
      { tipo: 'seguimiento', nombre: 'Pedro', vendedor: 'Ana' },
      { tipo: 'contestar', nombre: 'Rosa', vendedor: 'Beto' },
    ],
    analisis_con_error_24h: 2,
    clientes_sin_analizar: 0,
  };
  const [r] = await f5.resumir([{ datos }], ctx);
  const [tarea] = hubspot.tareas();
  assert.equal(r.para, 'administrador');
  assert.equal(r.hubspot_task_id, tarea.id);
  assert.equal(tarea.properties.hubspot_owner_id, '900');
  assert.equal(tarea.properties.hs_task_subject, 'Resumen WhatsApp 30/09: 1 sin responder, 3 tareas vencidas');
  const cuerpo = tarea.properties.hs_task_body;
  assert.match(cuerpo, /Luis \(Ana\) — esperando desde 29\/09 16:00, 16 h/);
  assert.match(cuerpo, /<b>Ana<\/b> \(2\): cotizar — Luis; seguimiento — Pedro/);
  assert.match(cuerpo, /Luis \(WhatsApp\) — Ana Pérez — termos x 200/);
  assert.match(cuerpo, /Cotizado: <b>1<\/b>/);
  assert.match(cuerpo, /Ana \(WhatsApp\) — Beto Gil — motivo: Precio fuera de presupuesto/);
  assert.match(cuerpo, /2 análisis de IA con error/);
});

test('F5 resumen personal para cada vendedor con pendientes', async () => {
  const ahora = new Date('2026-09-30T11:30:00Z'); // miércoles 7:30 en Caracas
  const { ctx, hubspot } = crearCtx({ env: envPrueba({ ADMIN_HUBSPOT_OWNER_ID: '' }), ahora });
  hubspot.agregar('deals', { pipeline: 'p1', dealstage: ETAPAS_IDS.cotizado, dealname: 'Luis (WhatsApp)', hubspot_owner_id: '1', producto: 'termos', cantidad: '200' });
  const datos = {
    vendedores: [{ nombre: 'Ana', hubspot_owner_id: '1' }, { nombre: 'Beto', hubspot_owner_id: '2' }, { nombre: 'Caro', hubspot_owner_id: '3' }],
    sin_responder: [{ telefono: TEL, nombre: 'Luis', vendedor: 'Ana', vendedor_owner_id: '1', desde: '2026-09-29T20:00:00Z' }],
    tareas_vencidas: [{ tipo: 'cotizar', nombre: 'Pedro', vendedor: 'Beto', vendedor_owner_id: '2', vence_at: '2026-09-29T15:00:00Z' }],
    tareas_abiertas: [
      { tipo: 'cotizar', nombre: 'Pedro', vendedor_owner_id: '2', vence_at: '2026-09-29T15:00:00Z' },
      { tipo: 'seguimiento', nombre: 'Rosa', vendedor_owner_id: '1', vence_at: '2026-09-30T18:00:00Z' },
      { tipo: 'confirmar', nombre: 'Juan', vendedor_owner_id: '1', vence_at: '2026-10-02T18:00:00Z' },
    ],
  };
  const creadas = await f5.resumir([{ datos }], ctx);
  assert.deepEqual(creadas.map((c) => c.para), ['Ana', 'Beto'], 'Caro no tiene pendientes');
  const [ana, beto] = hubspot.tareas();
  assert.equal(ana.properties.hubspot_owner_id, '1');
  assert.equal(ana.properties.hs_task_subject, 'Tus pendientes 30/09: 1 por responder, 0 vencidas, 1 para hoy');
  assert.match(ana.properties.hs_task_body, /Buenos días, Ana/);
  assert.match(ana.properties.hs_task_body, /Luis — desde 29\/09 16:00 \(16 h\)/);
  assert.match(ana.properties.hs_task_body, /Seguimiento de cotización — Rosa \(a las 14:00\)/);
  assert.doesNotMatch(ana.properties.hs_task_body, /Juan/, 'la de otro día no es de hoy');
  assert.match(ana.properties.hs_task_body, /Luis \(WhatsApp\) — termos x 200/);
  assert.equal(beto.properties.hubspot_owner_id, '2');
  assert.equal(beto.properties.hs_task_subject, 'Tus pendientes 30/09: 0 por responder, 1 vencidas, 0 para hoy');
  assert.match(beto.properties.hs_task_body, /Enviar cotización — Pedro \(venció 29\/09 11:00\)/);
  assert.equal(hubspot.tareas().length, 2, 'sin administrador no hay resumen general');
});

test('F5 no manda nada en días no laborables ni sin pendientes', async () => {
  const sabado = crearCtx({ env: envPrueba({ HORARIO_LABORAL: 'lun-vie 09:00-17:00' }), ahora: new Date('2026-10-03T11:30:00Z') });
  assert.deepEqual(await f5.resumir([{ datos: { vendedores: [{ nombre: 'Ana', hubspot_owner_id: '1' }] } }], sabado.ctx), [{ omitido: 'día no laborable' }]);
  assert.equal(sabado.hubspot.tareas().length, 0);
  const vacio = crearCtx({ env: envPrueba({ ADMIN_HUBSPOT_OWNER_ID: '' }), ahora: new Date('2026-09-30T11:30:00Z') });
  assert.deepEqual(await f5.resumir([{ datos: { vendedores: [{ nombre: 'Ana', hubspot_owner_id: '1' }] } }], vacio.ctx), [{ omitido: 'nadie tiene pendientes' }]);
});
