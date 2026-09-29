'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  construirSolicitud, construirContexto, interpretarRespuesta, validarAnalisis, analizarConversacion, ErrorClaude, ESQUEMA,
} = require('../src/claude');
const { leerConfig } = require('../src/config');
const SISTEMA = require('../src/prompt');
const { envPrueba, crearClaudeFalso, analisis } = require('./apoyo/falsos');

const config = leerConfig(envPrueba());

test('solicitud: modelo, caché del system prompt, salida estructurada y fallback', () => {
  const s = construirSolicitud(config, 'contexto');
  assert.equal(s.url, 'http://claude.prueba/v1/messages');
  assert.equal(s.headers['x-api-key'], 'clave-prueba');
  assert.equal(s.headers['anthropic-version'], '2023-06-01');
  assert.equal(s.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(s.body.model, 'claude-sonnet-5-5');
  assert.equal(s.body.fallbacks, 'default');
  assert.deepEqual(s.body.system, [{ type: 'text', text: SISTEMA, cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(s.body.messages, [{ role: 'user', content: 'contexto' }]);
  assert.equal(s.body.output_config.effort, 'low');
  assert.equal(s.body.output_config.format.type, 'json_schema');
  assert.equal(s.body.output_config.format.schema, ESQUEMA);
  assert.equal(s.body.thinking, undefined);

  const sinFallback = construirSolicitud(leerConfig(envPrueba({ ANTHROPIC_FALLBACK: 'no' })), 'x');
  assert.equal(sinFallback.body.fallbacks, undefined);
  assert.equal(sinFallback.headers['anthropic-beta'], undefined);
});

test('el system prompt no tiene partes variables (para que la caché funcione)', () => {
  assert.ok(SISTEMA.length > 3000);
  assert.doesNotMatch(SISTEMA, /\$\{|\{\{/);
});

test('el esquema exige todos los campos y no admite extras', () => {
  const revisar = (s) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(revisar);
    }
    if (s.type === 'array') revisar(s.items);
    (s.anyOf || []).forEach(revisar);
  };
  revisar(ESQUEMA);
});

test('contexto: fecha local, etapa, tareas y conversación en orden', () => {
  const texto = construirContexto({
    cliente: { nombre_wa: 'Luis' },
    etapaActual: 'solicitud',
    datos: { producto: 'termos', cantidad: null },
    tareasAbiertas: [{ tipo: 'cotizar' }, { tipo: 'cotizar' }],
    mensajes: [
      { direccion: 'entrante', tipo: 'text', texto: 'Hola', ts: '2026-09-29T12:00:00Z' },
      { direccion: 'saliente', tipo: 'image', texto: null, ts: '2026-09-29T12:05:00Z' },
    ],
    ahora: new Date('2026-09-29T14:00:00Z'),
    tz: 'America/Caracas',
  });
  assert.match(texto, /Fecha y hora actual: martes 2026-09-29 10:00 \(America\/Caracas\)/);
  assert.match(texto, /Etapa actual del negocio: solicitud/);
  assert.match(texto, /producto: termos; cantidad: sin dato/);
  assert.match(texto, /Tareas abiertas: cotizar\n/);
  assert.match(texto, /<conversacion>\n\[2026-09-29 08:00\] CLIENTE: Hola\n\[2026-09-29 08:05\] VENDEDOR: \[image\]\n<\/conversacion>/);
});

const respuesta = (texto, extra = {}) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: texto }],
  ...extra,
});

test('interpreta la respuesta leyendo bloques de texto por tipo', () => {
  const a = interpretarRespuesta(respuesta(JSON.stringify(analisis({ etapa_detectada: 'cotizado', confianza: 0.85 }))));
  assert.equal(a.etapa_detectada, 'cotizado');
  assert.equal(a.confianza, 0.85);
  const conBloque = interpretarRespuesta(respuesta(`\`\`\`json\n${JSON.stringify(analisis())}\n\`\`\``));
  assert.equal(conBloque.etapa_detectada, 'sin_cambio');
});

test('rechazo y max_tokens', () => {
  assert.throws(
    () => interpretarRespuesta({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }),
    (e) => e instanceof ErrorClaude && e.tipo === 'rechazo' && /cyber/.test(e.message),
  );
  assert.throws(() => interpretarRespuesta(respuesta('{"a":', { stop_reason: 'max_tokens' })), (e) => e.tipo === 'max_tokens');
  assert.throws(() => interpretarRespuesta(respuesta('no es json')), (e) => e.tipo === 'json_invalido');
});

test('validación del contrato', () => {
  const ok = validarAnalisis(analisis({
    confianza: '0.8',
    datos_pedido: { producto: '  ', cantidad: '150', fecha_entrega: '2026-12-01', empresa_cliente: 'Acme' },
    tareas_nuevas: [{ tipo: 'cotizar', titulo: ' Cotizar ', detalle: 'd' }],
  }));
  assert.equal(ok.confianza, 0.8);
  assert.deepEqual(ok.datos_pedido, { producto: null, cantidad: 150, fecha_entrega: '2026-12-01', empresa_cliente: 'Acme' });
  assert.equal(ok.tareas_nuevas[0].titulo, 'Cotizar');

  const malos = [
    analisis({ etapa_detectada: 'pagado' }),
    analisis({ confianza: 1.5 }),
    analisis({ confianza: null }),
    analisis({ datos_pedido: { producto: null, cantidad: 'muchos', fecha_entrega: null, empresa_cliente: null } }),
    analisis({ datos_pedido: { producto: null, cantidad: null, fecha_entrega: '2026-02-30', empresa_cliente: null } }),
    analisis({ tareas_nuevas: [{ tipo: 'produccion', titulo: 'x', detalle: '' }] }),
    analisis({ tareas_nuevas: 'ninguna' }),
    analisis({ resumen: null }),
  ];
  for (const m of malos) assert.throws(() => validarAnalisis(m), (e) => e.tipo === 'json_invalido', JSON.stringify(m));
});

test('reintenta una vez si el JSON es inválido', async () => {
  const claude = crearClaudeFalso();
  claude.responder('{"roto": ');
  claude.responder(analisis({ etapa_detectada: 'solicitud' }));
  const r = await analizarConversacion({ http: claude.http, config, contexto: 'x', esperar: async () => {} });
  assert.equal(r.analisis.etapa_detectada, 'solicitud');
  assert.equal(claude.solicitudes.length, 2);
  assert.equal(r.usage.cache_read_input_tokens, 1500);
});

test('dos JSON inválidos seguidos → error', async () => {
  const claude = crearClaudeFalso();
  claude.responder('{"roto": ');
  claude.responder(analisis({ etapa_detectada: 'inventada' }));
  await assert.rejects(
    analizarConversacion({ http: claude.http, config, contexto: 'x', esperar: async () => {} }),
    (e) => e.tipo === 'json_invalido',
  );
});

test('reintenta ante 429 y 529; no ante 400', async () => {
  const claude = crearClaudeFalso();
  claude.responderError(429, { error: { type: 'rate_limit_error', message: 'lento' } }, { 'retry-after': '1' });
  claude.responderError(529, { error: { type: 'overloaded_error', message: 'ocupado' } });
  claude.responder(analisis());
  const r = await analizarConversacion({ http: claude.http, config, contexto: 'x', esperar: async () => {} });
  assert.equal(r.analisis.etapa_detectada, 'sin_cambio');

  const otro = crearClaudeFalso();
  otro.responderError(400, { error: { type: 'invalid_request_error', message: 'mal' } });
  await assert.rejects(
    analizarConversacion({ http: otro.http, config, contexto: 'x', esperar: async () => {} }),
    /400: invalid_request_error: mal/,
  );
  assert.equal(otro.solicitudes.length, 1);
});
