'use strict';

// Utilidades compartidas por los flujos.
//
// Cada paso de flujo recibe (entrada, ctx, extra):
//   entrada: lista de objetos (los items que llegan al Code node de n8n)
//   ctx:     { env, http, ahora(), esperar(ms) }
//   extra:   datos de otros nodos del mismo flujo
// y devuelve una lista de objetos (los items de salida). Lista vacía = el flujo
// se detiene en ese nodo.

const { leerConfig, exigir } = require('../config');
const { crearHubSpot } = require('../hubspot');
const { parsearHorario } = require('../horario');

function preparar(ctx, requisitos = []) {
  const config = leerConfig(ctx.env);
  exigir(config, requisitos);
  const hs = requisitos.includes('hubspot')
    ? crearHubSpot({ http: ctx.http, token: config.hubspot.token, apiUrl: config.hubspot.apiUrl, esperar: ctx.esperar })
    : null;
  const cal = config.horarioLaboral ? parsearHorario(config.horarioLaboral, config.feriados) : null;
  return { config, hs, cal, ahora: ctx.ahora ? ctx.ahora() : new Date() };
}

function escaparHtml(texto) {
  return String(texto == null ? '' : texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lista(items) {
  return items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : '<p>—</p>';
}

module.exports = { preparar, escaparHtml, lista };
