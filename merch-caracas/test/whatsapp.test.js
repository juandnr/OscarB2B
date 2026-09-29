'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizarWebhook, secretoValido } = require('../src/whatsapp');
const { aE164, variantesBusqueda } = require('../src/telefono');

const fixture = (nombre) => require(`./fixtures/${nombre}.json`);

test('mensaje entrante de texto con nombre de perfil', () => {
  const { mensajes } = normalizarWebhook(fixture('mensaje-texto'));
  assert.equal(mensajes.length, 1);
  const m = mensajes[0];
  assert.equal(m.id, 'wamid.ENTRANTE1');
  assert.equal(m.telefono, '+584141234567');
  assert.equal(m.direccion, 'entrante');
  assert.equal(m.origen, 'messages');
  assert.equal(m.tipo, 'text');
  assert.equal(m.texto, 'Buenas, necesito 200 termos con logo para diciembre');
  assert.equal(m.nombre_wa, 'Luis Rojas');
  assert.equal(m.ts, '2026-09-29T12:00:00.000Z');
  assert.equal(m.raw.id, 'wamid.ENTRANTE1');
});

test('imagen con texto y reacción', () => {
  const { mensajes } = normalizarWebhook(fixture('mensaje-imagen'));
  assert.equal(mensajes.length, 2);
  assert.equal(mensajes[0].tipo, 'image');
  assert.equal(mensajes[0].media_id, 'MEDIA123');
  assert.equal(mensajes[0].texto, '[imagen] listo, ahí va el pago móvil');
  assert.equal(mensajes[1].tipo, 'reaction');
  assert.equal(mensajes[1].texto, '[reacción 👍]');
});

test('los estados de entrega se ignoran', () => {
  const { mensajes, ignorados } = normalizarWebhook(fixture('estados'));
  assert.equal(mensajes.length, 0);
  assert.match(ignorados[0], /estado/);
});

test('eco de la app: saliente hacia el cliente', () => {
  const { mensajes } = normalizarWebhook(fixture('eco'));
  assert.equal(mensajes.length, 1);
  assert.equal(mensajes[0].direccion, 'saliente');
  assert.equal(mensajes[0].origen, 'echo');
  assert.equal(mensajes[0].telefono, '+584141234567');
  assert.equal(mensajes[0].nombre_wa, null);
});

test('historial: la dirección sale de quién escribe en el hilo', () => {
  const { mensajes } = normalizarWebhook(fixture('historial'));
  assert.equal(mensajes.length, 2);
  assert.deepEqual(mensajes.map((m) => [m.direccion, m.origen, m.telefono]), [
    ['entrante', 'history', '+584249876543'],
    ['saliente', 'history', '+584249876543'],
  ]);
  assert.equal(mensajes[1].texto, '[documento: cotizacion-gorras.pdf]');
});

test('un mensaje con teléfono inválido no tumba el resto', () => {
  const body = fixture('mensaje-texto');
  const copia = JSON.parse(JSON.stringify(body));
  copia.entry[0].changes[0].value.messages.push({ from: '12', id: 'wamid.MALO', timestamp: '1790683200', type: 'text', text: { body: 'x' } });
  const { mensajes, ignorados } = normalizarWebhook(copia);
  assert.equal(mensajes.length, 1);
  assert.match(ignorados.join(), /wamid.MALO/);
});

test('payload que no es de WhatsApp', () => {
  const { mensajes, ignorados } = normalizarWebhook({ hola: 1 });
  assert.equal(mensajes.length, 0);
  assert.equal(ignorados.length, 1);
});

test('anuncio clic a WhatsApp queda en el texto', () => {
  const body = JSON.parse(JSON.stringify(fixture('mensaje-texto')));
  body.entry[0].changes[0].value.messages[0].referral = { headline: 'Termos corporativos', source_url: 'https://fb.me/x' };
  const { mensajes } = normalizarWebhook(body);
  assert.match(mensajes[0].texto, /^\[llegó desde anuncio: Termos corporativos\] Buenas/);
});

test('secreto del webhook por encabezado o por query', () => {
  const s = 'secreto-de-prueba-123456789';
  assert.equal(secretoValido({ headers: { 'x-webhook-secret': s } }, s), true);
  assert.equal(secretoValido({ query: { secreto: s } }, s), true);
  assert.equal(secretoValido({ headers: { 'x-webhook-secret': 'otro' } }, s), false);
  assert.equal(secretoValido({}, s), false);
  assert.throws(() => secretoValido({}, ''), /no está configurado/);
});

test('teléfonos', () => {
  assert.equal(aE164('584141234567'), '+584141234567');
  assert.equal(aE164('+58 414-123-4567'), '+584141234567');
  assert.throws(() => aE164('123'), /inválido/);
  assert.deepEqual(variantesBusqueda('+584141234567'), [
    '+584141234567', '584141234567', '04141234567', '0414-1234567', '+58 414 1234567',
  ]);
  assert.deepEqual(variantesBusqueda('+13055551234'), ['+13055551234', '13055551234']);
});
