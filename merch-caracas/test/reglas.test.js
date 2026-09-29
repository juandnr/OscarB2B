'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decidir } = require('../src/reglas');
const { tituloTarea, vencimiento, tareaPermitida } = require('../src/tareas');
const { esAvance } = require('../src/etapas');
const { leerConfig } = require('../src/config');
const { parsearHorario } = require('../src/horario');
const { analisis, envPrueba } = require('./apoyo/falsos');

const cliente = { telefono: '+584141234567', nombre_wa: 'Luis' };

function decide(etapaActual, extra, tareasAbiertas = []) {
  return decidir({ analisis: analisis(extra), etapaActual, tareasAbiertas, cliente });
}

test('avanza de etapa y crea la tarea de entrada', () => {
  const d = decide('nuevo', {
    etapa_detectada: 'solicitud',
    datos_pedido: { producto: 'termos con logo', cantidad: 200, fecha_entrega: null, empresa_cliente: 'Acme' },
  });
  assert.equal(d.etapaNueva, 'solicitud');
  assert.equal(d.negocioNuevo, null);
  assert.deepEqual(d.tareas.map((t) => [t.tipo, t.titulo, t.origen]), [
    ['cotizar', 'Enviar cotización a Luis: termos con logo x 200', 'etapa'],
  ]);
  assert.deepEqual(d.propiedades, { producto: 'termos con logo', cantidad: 200, empresa_cliente: 'Acme', resumen_ia: 'El cliente saludó.' });
});

test('nunca retrocede', () => {
  const d = decide('cotizado', { etapa_detectada: 'solicitud' });
  assert.equal(d.etapaNueva, null);
  assert.match(d.descartes.join(), /no se retrocede/);
});

test('misma etapa: sin cambio y sin descarte', () => {
  const d = decide('cotizado', { etapa_detectada: 'cotizado' });
  assert.equal(d.etapaNueva, null);
  assert.deepEqual(d.descartes, []);
});

test('comprobante → verificar_pago, nunca pagado', () => {
  const d = decide('cotizado', { etapa_detectada: 'verificar_pago' });
  assert.equal(d.etapaNueva, 'verificar_pago');
  assert.deepEqual(d.tareas.map((t) => t.tipo), ['verificar_pago']);
});

test('la IA no salta el pago: listo/enviado/entregado antes de pagado → verificar_pago', () => {
  for (const detectada of ['listo_para_enviar', 'enviado', 'entregado']) {
    const d = decide('cotizado', { etapa_detectada: detectada });
    assert.equal(d.etapaNueva, 'verificar_pago', detectada);
    assert.match(d.descartes.join(), /pago que nadie ha verificado/);
  }
  const yaEnVerificar = decide('verificar_pago', { etapa_detectada: 'enviado' });
  assert.equal(yaEnVerificar.etapaNueva, null);
});

test('después de pagado sí puede avanzar a enviado', () => {
  const d = decide('pagado', { etapa_detectada: 'enviado' });
  assert.equal(d.etapaNueva, 'enviado');
  assert.deepEqual(d.tareas.map((t) => t.tipo), ['confirmar']);
});

test('confianza < 0.7 → sin cambio y sin tareas', () => {
  const d = decide('nuevo', {
    etapa_detectada: 'solicitud',
    confianza: 0.6,
    tareas_nuevas: [{ tipo: 'contestar', titulo: 'Contestar a Luis', detalle: 'x' }],
    datos_pedido: { producto: 'gorras', cantidad: null, fecha_entrega: null, empresa_cliente: null },
  });
  assert.equal(d.etapaNueva, null);
  assert.deepEqual(d.tareas, []);
  assert.equal(d.propiedades.producto, 'gorras');
  assert.equal(d.descartes.length, 2);
});

test('no duplica tareas abiertas del mismo tipo', () => {
  const d = decide('nuevo', {
    etapa_detectada: 'solicitud',
    tareas_nuevas: [
      { tipo: 'cotizar', titulo: 'Cotizar', detalle: 'detalle de Claude' },
      { tipo: 'contestar', titulo: 'Contestar a Luis', detalle: 'preguntó por colores' },
      { tipo: 'contestar', titulo: 'Contestar otra vez', detalle: 'dup' },
    ],
  }, [{ tipo: 'contestar' }]);
  assert.deepEqual(d.tareas.map((t) => [t.tipo, t.detalle]), [['cotizar', 'detalle de Claude']]);
  assert.match(d.descartes.join(), /ya hay una tarea "contestar" abierta/);
});

test('tareas que no aplican a la etapa se descartan', () => {
  const d = decide('solicitud', {
    etapa_detectada: 'sin_cambio',
    tareas_nuevas: [{ tipo: 'enviar', titulo: 'Enviar pedido', detalle: '' }],
  });
  assert.deepEqual(d.tareas, []);
  assert.match(d.descartes.join(), /no aplica/);
});

test('negocio cerrado + pedido nuevo → abre negocio nuevo', () => {
  const d = decide('entregado', { etapa_detectada: 'solicitud' });
  assert.equal(d.negocioNuevo, 'solicitud');
  assert.equal(d.etapaNueva, null);
  assert.deepEqual(d.tareas.map((t) => t.tipo), ['cotizar']);
  const perdido = decide('perdido', { etapa_detectada: 'cotizado' });
  assert.equal(perdido.negocioNuevo, null);
  assert.match(perdido.descartes.join(), /cerrado/);
});

test('esAvance', () => {
  assert.equal(esAvance('nuevo', 'cotizado'), true);
  assert.equal(esAvance('cotizado', 'nuevo'), false);
  assert.equal(esAvance('entregado', 'nuevo'), false);
  assert.equal(esAvance('nuevo', 'perdido'), false);
});

test('títulos de tareas', () => {
  assert.equal(tituloTarea('contestar', { telefono: '+58414', nombre_wa: '' }), 'Contestar a +58414');
  assert.equal(tituloTarea('cotizar', cliente, {}), 'Enviar cotización a Luis');
  assert.equal(tituloTarea('cotizar', cliente, { cantidad: 50 }), 'Enviar cotización a Luis: x 50');
  assert.equal(tituloTarea('verificar_pago', cliente), 'Verificar pago de Luis');
  assert.equal(tituloTarea('produccion', cliente), 'Iniciar producción del pedido de Luis');
  assert.equal(tituloTarea('enviar', cliente), 'Enviar pedido a Luis');
  assert.equal(tituloTarea('confirmar', cliente), 'Confirmar recepción con Luis');
});

test('fechas límite', () => {
  const config = leerConfig(envPrueba());
  const cal = parsearHorario(config.horarioLaboral);
  const ahora = new Date('2026-09-29T14:00:00Z'); // martes 10:00 Caracas
  const v = (tipo, extra = {}) => vencimiento(tipo, { ahora, config, cal, ...extra }).toISOString();
  assert.equal(v('contestar'), '2026-09-29T14:15:00.000Z');
  assert.equal(v('contestar', { inmediata: true }), '2026-09-29T14:00:00.000Z');
  assert.equal(v('cotizar'), '2026-09-30T14:00:00.000Z');
  assert.equal(v('verificar_pago'), '2026-09-29T18:00:00.000Z');
  assert.equal(v('produccion'), '2026-09-30T14:00:00.000Z');
  assert.equal(v('confirmar'), '2026-10-01T14:00:00.000Z');
  // seguimiento: 48 h desde el envío de la cotización
  assert.equal(v('seguimiento', { ultimoMsgEmpresaAt: '2026-09-29T13:00:00Z' }), '2026-10-01T13:00:00.000Z');
  // enviar: día anterior a la entrega, 09:00 Caracas
  assert.equal(v('enviar', { fechaEntrega: '2026-10-10' }), '2026-10-09T13:00:00.000Z');
  // entrega ya pasada → vence ya
  assert.equal(v('enviar', { fechaEntrega: '2026-09-29' }), '2026-09-29T14:00:00.000Z');
  assert.equal(v('enviar'), '2026-09-30T14:00:00.000Z');
  assert.throws(() => vencimiento('contestar', { ahora, config, cal: null }), /HORARIO_LABORAL/);
});

test('tareas permitidas por etapa', () => {
  assert.equal(tareaPermitida('cotizar', 'solicitud'), true);
  assert.equal(tareaPermitida('cotizar', 'verificar_pago'), false);
  assert.equal(tareaPermitida('verificar_pago', 'cotizado'), true);
  assert.equal(tareaPermitida('verificar_pago', 'pagado'), false);
  assert.equal(tareaPermitida('enviar', 'cotizado'), false);
  assert.equal(tareaPermitida('enviar', 'listo_para_enviar'), true);
  assert.equal(tareaPermitida('confirmar', 'listo_para_enviar'), false);
  assert.equal(tareaPermitida('contestar', 'perdido'), true);
  assert.equal(tareaPermitida('cotizar', 'entregado'), false);
});
