'use strict';

// Script de Google Apps Script (gmail/Codigo.gs) con Gmail, UrlFetchApp y
// PropertiesService simulados, y su contrato con src/correo.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { normalizarLote } = require('../src/correo');

const CODIGO = fs.readFileSync(path.join(__dirname, '..', 'gmail', 'Codigo.gs'), 'utf8');
const MANIFIESTO = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'gmail', 'appsscript.json'), 'utf8'));

const b64 = (texto) => Buffer.from(texto, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const bytes = (texto) => [...Buffer.from(texto, 'utf8')].map((b) => (b > 127 ? b - 256 : b)); // byte[] de Java

function mensaje(id, internalDate, labelIds, { from, to = 'ventas@m.com', subject = 'Hola', partes, headers = [] }) {
  return {
    id, threadId: `h-${id}`, internalDate: String(internalDate), labelIds,
    payload: {
      mimeType: 'multipart/alternative',
      headers: [{ name: 'From', value: from }, { name: 'To', value: to }, { name: 'Subject', value: subject }, ...headers],
      parts: partes,
    },
  };
}

function entorno({ url = 'https://abc.supabase.co/functions/v1/merch', secreto = 'secreto-123', mensajes = [], respuesta = 200 } = {}) {
  const props = {};
  const llamadas = { list: [], fetch: [], triggers: [] };
  let triggers = [];
  const contexto = {
    Gmail: {
      Users: {
        Messages: {
          list: (usuario, opciones) => {
            llamadas.list.push(opciones);
            return { messages: mensajes.map((m) => ({ id: m.id })) };
          },
          get: (usuario, id) => mensajes.find((m) => m.id === id),
        },
      },
    },
    Utilities: {
      base64DecodeWebSafe: (s) => [...Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')],
      newBlob: (b) => ({ getDataAsString: () => Buffer.from(b.map((x) => (x < 0 ? x + 256 : x))).toString('utf8') }),
    },
    UrlFetchApp: {
      fetch: (u, o) => {
        llamadas.fetch.push({ url: u, ...o, cuerpo: JSON.parse(o.payload) });
        return { getResponseCode: () => respuesta, getContentText: () => (respuesta === 200 ? '{"ok":true}' : 'Secreto inválido') };
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }),
    },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      deleteTrigger: (t) => { triggers = triggers.filter((x) => x !== t); },
      newTrigger: (fn) => ({
        timeBased: () => ({
          everyMinutes: (n) => ({
            create: () => {
              const t = { getHandlerFunction: () => fn, minutos: n };
              triggers.push(t);
              llamadas.triggers.push(t);
              return t;
            },
          }),
        }),
      }),
    },
    Logger: { log: () => {} },
  };
  const codigo = CODIGO
    .replace(/^const URL_FUNCION = .*$/m, `const URL_FUNCION = ${JSON.stringify(url)};`)
    .replace(/^const SECRETO = .*$/m, `const SECRETO = ${JSON.stringify(secreto)};`);
  vm.createContext(contexto);
  vm.runInContext(`${codigo}\nthis.api = { instalar, desinstalar, revisarCorreo };`, contexto);
  return { api: contexto.api, props, llamadas, triggers: () => triggers };
}

test('el manifiesto pide solo leer Gmail y activa el servicio de Gmail', () => {
  assert.deepEqual(MANIFIESTO.oauthScopes.sort(), [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.scriptapp',
  ]);
  assert.deepEqual(MANIFIESTO.dependencies.enabledAdvancedServices, [{ userSymbol: 'Gmail', serviceId: 'gmail', version: 'v1' }]);
});

test('instalar exige llenar URL y secreto, y deja un solo disparador cada 5 minutos', () => {
  assert.throws(() => entorno({ url: 'https://TU-PROYECTO.supabase.co/functions/v1/merch' }).api.instalar(), /Falta llenar/);
  assert.throws(() => entorno({ secreto: 'PEGA-AQUI-EL-SECRETO' }).api.instalar(), /Falta llenar/);
  const e = entorno();
  e.api.instalar();
  e.api.instalar();
  assert.equal(e.triggers().length, 1);
  assert.equal(e.triggers()[0].minutos, 5);
  assert.equal(e.llamadas.fetch.length, 2, 'instalar hace una primera revisión');
  e.api.desinstalar();
  assert.equal(e.triggers().length, 0);
});

test('manda recibidos y enviados del más viejo al más nuevo, sin Promociones, y no repite', () => {
  const ahora = Date.now();
  const recibido = mensaje('m1', ahora - 300000, ['INBOX', 'CATEGORY_PERSONAL'], {
    from: 'Juan Pérez <juan@acme.com>', subject: 'Cotización',
    partes: [
      { mimeType: 'text/plain', body: { data: b64('Necesito 200 termos.\n\nEl lun, Ventas <v@m.com> escribió:\n> hola') } },
      { mimeType: 'text/html', body: { data: b64('<p>Necesito 200 termos.</p>') } },
    ],
    headers: [{ name: 'Cc', value: 'Ana <ana@acme.com>' }],
  });
  const promo = mensaje('m2', ahora - 200000, ['INBOX', 'CATEGORY_PROMOTIONS'], { from: 'ofertas@tienda.com', partes: [] });
  const enviado = mensaje('m3', ahora - 100000, ['SENT', 'CATEGORY_PROMOTIONS'], {
    from: 'ventas@m.com', to: 'juan@acme.com', subject: 'Re: Cotización',
    partes: [{ mimeType: 'text/html', body: { data: bytes('<div>Hola Juan,<br>va la cotización &amp; el catálogo</div><style>p{}</style>') } }],
    headers: [{ name: 'List-Unsubscribe', value: '<mailto:x>' }],
  });
  const e = entorno({ mensajes: [enviado, promo, recibido] }); // Gmail: del más nuevo al más viejo

  e.api.revisarCorreo();
  const [envio] = e.llamadas.fetch;
  assert.equal(envio.url, 'https://abc.supabase.co/functions/v1/merch/correo');
  assert.equal(envio.headers['X-Webhook-Secret'], 'secreto-123');
  assert.match(e.llamadas.list[0].q, /^after:\d+ -in:spam -in:trash -in:drafts -in:chats$/);
  const desde = Number(/after:(\d+)/.exec(e.llamadas.list[0].q)[1]);
  assert.ok(Math.abs(desde - (Math.floor((ahora - 3600000) / 1000) - 600)) <= 2, 'la primera vez, la última hora');

  assert.deepEqual(envio.cuerpo.correos.map((c) => c.id), ['m1', 'm3']);
  const [c1, c3] = envio.cuerpo.correos;
  assert.equal(c1.texto, 'Necesito 200 termos.\n\nEl lun, Ventas <v@m.com> escribió:\n> hola');
  assert.equal(c3.texto, 'Hola Juan,\nva la cotización & el catálogo');
  assert.equal(c3.cabeceras.list_unsubscribe, true);
  assert.equal(e.props.desde_ms, String(ahora - 100000));
  assert.deepEqual(JSON.parse(e.props.enviados), ['m1', 'm2', 'm3']);

  // Lo que manda el script lo entiende el sistema
  const lote = normalizarLote(envio.cuerpo);
  assert.deepEqual(lote.map((c) => [c.id, c.direccion, c.de_email, c.destinatarios, c.texto]), [
    ['m1', 'entrante', 'juan@acme.com', ['ventas@m.com', 'ana@acme.com'], 'Necesito 200 termos.'],
    ['m3', 'saliente', 'ventas@m.com', ['juan@acme.com'], 'Hola Juan,\nva la cotización & el catálogo'],
  ]);

  // Segunda corrida: nada nuevo, igual avisa (para retomar pendientes)
  e.api.revisarCorreo();
  assert.deepEqual(e.llamadas.fetch[1].cuerpo, { correos: [] });
  assert.match(e.llamadas.list[1].q, new RegExp(`^after:${Math.floor((ahora - 100000) / 1000) - 600} `));
});

test('si la función responde con error, falla y no avanza', () => {
  const e = entorno({ respuesta: 401, mensajes: [mensaje('m1', Date.now(), ['INBOX'], { from: 'a@b.com', partes: [] })] });
  assert.throws(() => e.api.revisarCorreo(), /La función respondió 401: Secreto inválido/);
  assert.equal(e.props.desde_ms, undefined);
  assert.equal(e.props.enviados, undefined);
});
