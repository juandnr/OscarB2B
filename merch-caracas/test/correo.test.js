'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  esCorreo, claveCorreo, emailDe, direccion, direcciones, limpiarTexto, normalizarLote, motivoAutomatico, textoMensaje,
} = require('../src/correo');
const { nombreCliente, canalCliente } = require('../src/tareas');

test('claves de clientes de correo', () => {
  assert.equal(claveCorreo(' Juan@X.com '), 'correo:juan@x.com');
  assert.equal(esCorreo('correo:juan@x.com'), true);
  assert.equal(esCorreo('+584141234567'), false);
  assert.equal(emailDe('correo:juan@x.com'), 'juan@x.com');
  assert.equal(emailDe('+584141234567'), null);
  assert.equal(nombreCliente({ telefono: 'correo:juan@x.com', nombre_wa: null }), 'juan@x.com');
  assert.equal(nombreCliente({ telefono: 'correo:juan@x.com', nombre_wa: 'Juan' }), 'Juan');
  assert.equal(nombreCliente({ telefono: '+584141234567' }), '+584141234567');
  assert.deepEqual([canalCliente('correo:a@b.co'), canalCliente('+58414')], ['Correo', 'WhatsApp']);
});

test('direcciones de correo', () => {
  assert.deepEqual(direccion('Juan Pérez <Juan.Perez@Empresa.com.ve>'), { nombre: 'Juan Pérez', email: 'juan.perez@empresa.com.ve' });
  assert.deepEqual(direccion('"Pérez, Juan" <jp@x.com>'), { nombre: 'Pérez, Juan', email: 'jp@x.com' });
  assert.deepEqual(direccion('jp@x.com'), { nombre: null, email: 'jp@x.com' });
  assert.equal(direccion('sin correo'), null);
  assert.deepEqual(direcciones('a@x.com, "Gil, Ana" <B@y.com>, a@x.com'), ['a@x.com', 'b@y.com']);
  assert.deepEqual(direcciones(''), []);
});

test('limpia citas, encabezados de respuesta y firma', () => {
  const gmail = 'Perfecto, quiero 200.\n\nEl lun, 29 sept 2026 a las 9:00, Ventas <ventas@m.com> escribió:\n> Hola, el precio es...\n> Saludos';
  assert.equal(limpiarTexto(gmail), 'Perfecto, quiero 200.');
  const partido = 'Gracias!\nEl lun, 29 sept 2026 a las 9:00, Ventas Merch <\nventas@m.com> escribió:\n> cita';
  assert.equal(limpiarTexto(partido), 'Gracias!');
  const outlook = 'Adjunto comprobante.\r\n\r\nDe: Ventas <ventas@m.com>\r\nEnviado: lunes\r\nPara: Juan\r\nAsunto: Cotización';
  assert.equal(limpiarTexto(outlook), 'Adjunto comprobante.');
  assert.equal(limpiarTexto('Hola\n\n\n\nquiero termos\n-- \nJuan Pérez\nGerente'), 'Hola\n\nquiero termos');
  assert.equal(limpiarTexto('De: Juan, área de compras\nNecesito gorras'), 'De: Juan, área de compras\nNecesito gorras', '"De:" sin encabezado de correo no corta');
  assert.equal(limpiarTexto('x'.repeat(50), 10), `${'x'.repeat(10)}…`);
});

test('normaliza lo que manda el script de Gmail', () => {
  const lote = normalizarLote({
    correos: [
      {
        id: 'g1', hilo: 'h1', de: 'Juan <JUAN@x.com>', para: 'ventas@m.com', cc: 'Ana <ana@x.com>',
        asunto: ' Cotización ', fecha: 1790000000000, texto: 'Quiero 100 gorras\n> cita', etiquetas: ['INBOX', 'CATEGORY_PERSONAL'],
        cabeceras: { list_unsubscribe: false, precedence: 'Bulk', auto_submitted: null },
      },
      { id: 'g2', de: 'Ventas <ventas@m.com>', para: 'juan@x.com', fecha: '2026-10-01T15:00:00Z', etiquetas: ['SENT'] },
      { id: 'g3', de: 'sin correo', fecha: 1790000000000 },
      { de: 'a@b.com', fecha: 1790000000000 },
      { id: 'g4', de: 'a@b.com', fecha: 'no es fecha' },
    ],
  });
  assert.equal(lote.length, 2);
  assert.deepEqual(lote[0], {
    id: 'g1', hilo: 'h1', direccion: 'entrante', de_email: 'juan@x.com', de_nombre: 'Juan',
    destinatarios: ['ventas@m.com', 'ana@x.com'], asunto: 'Cotización', texto: 'Quiero 100 gorras',
    fecha: new Date(1790000000000).toISOString(), etiquetas: ['INBOX', 'CATEGORY_PERSONAL'],
    cabeceras: { list_unsubscribe: false, precedence: 'bulk', auto_submitted: null },
  });
  assert.deepEqual([lote[1].direccion, lote[1].destinatarios, lote[1].fecha], ['saliente', ['juan@x.com'], '2026-10-01T15:00:00.000Z']);
  assert.deepEqual(normalizarLote(null), []);
  assert.deepEqual(normalizarLote({ correos: 'x' }), []);
});

test('descarta correos automáticos y masivos sin consultar a Claude', () => {
  const base = { de_email: 'juan@empresa.com', etiquetas: ['INBOX'], cabeceras: {} };
  assert.equal(motivoAutomatico(base), null);
  assert.equal(motivoAutomatico({ ...base, etiquetas: ['INBOX', 'CATEGORY_PROMOTIONS'] }), 'categoría de Gmail: Promociones');
  assert.equal(motivoAutomatico({ ...base, etiquetas: ['CATEGORY_UPDATES'] }), 'categoría de Gmail: Notificaciones');
  assert.equal(motivoAutomatico({ ...base, de_email: 'no-reply@banco.com' }), 'remitente automático');
  assert.equal(motivoAutomatico({ ...base, de_email: 'noreply+abc@x.com' }), 'remitente automático');
  assert.equal(motivoAutomatico({ ...base, de_email: 'notificaciones@x.com' }), 'remitente automático');
  assert.equal(motivoAutomatico({ ...base, de_email: 'newsletter@x.com' }), 'remitente automático');
  assert.equal(motivoAutomatico({ ...base, de_email: 'newton@x.com' }), null, 'no confunde nombres que empiezan igual');
  assert.equal(motivoAutomatico({ ...base, cabeceras: { list_unsubscribe: true } }), 'correo masivo (trae enlace para darse de baja)');
  assert.equal(motivoAutomatico({ ...base, cabeceras: { precedence: 'bulk' } }), 'correo masivo');
  assert.equal(motivoAutomatico({ ...base, cabeceras: { auto_submitted: 'auto-replied' } }), 'respuesta automática');
  assert.equal(motivoAutomatico({ ...base, cabeceras: { auto_submitted: 'no' } }), null);
  assert.equal(motivoAutomatico(base, ['empresa.com']), 'remitente en CORREO_IGNORAR (empresa.com)');
  assert.equal(motivoAutomatico({ ...base, de_email: 'a@ventas.empresa.com' }, ['@empresa.com']), 'remitente en CORREO_IGNORAR (empresa.com)');
  assert.equal(motivoAutomatico(base, ['juan@empresa.com']), 'remitente en CORREO_IGNORAR (juan@empresa.com)');
  assert.equal(motivoAutomatico(base, ['otra.com', 'pedro@empresa.com']), null);
});

test('texto del mensaje con el asunto', () => {
  assert.equal(textoMensaje({ asunto: 'Cotización', texto: 'Quiero 100' }), 'Asunto: Cotización\n\nQuiero 100');
  assert.equal(textoMensaje({ asunto: null, texto: '' }), '[correo sin texto]');
});
