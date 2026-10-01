'use strict';

// Empaqueta un módulo de src/ con todas sus dependencias en un solo bloque de
// código (sin require de Node), para pegarlo en un Code node de n8n o en la
// Edge Function de Supabase. Los prompts de prompts/ se incrustan como texto.

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

// Módulos que leen un prompt con fs → texto literal.
const PROMPTS = {
  'src/prompt.js': 'clasificador.md',
  'src/prompt-correo.js': 'correo.md',
};

function fuente(id) {
  if (PROMPTS[id]) {
    const texto = fs.readFileSync(path.join(RAIZ, 'prompts', PROMPTS[id]), 'utf8');
    return `'use strict';\nmodule.exports = ${JSON.stringify(texto)};\n`;
  }
  return fs.readFileSync(path.join(RAIZ, id), 'utf8');
}

function resolver(desde, ruta) {
  let id = path.posix.normalize(path.posix.join(path.posix.dirname(desde), ruta));
  if (!id.endsWith('.js')) id += '.js';
  return id;
}

// entrada: un módulo o una lista de módulos de src/.
function recolectar(entrada) {
  const modulos = new Map();
  const pendientes = [].concat(entrada);
  while (pendientes.length) {
    const id = pendientes.pop();
    if (modulos.has(id)) continue;
    const codigo = fuente(id);
    for (const m of codigo.matchAll(/require\('([^']+)'\)/g)) {
      if (!m[1].startsWith('.')) {
        throw new Error(`${id} requiere "${m[1]}": los módulos para n8n solo pueden requerir archivos de src/`);
      }
      pendientes.push(resolver(id, m[1]));
    }
    modulos.set(id, codigo);
  }
  return modulos;
}

function empaquetar(entrada) {
  const modulos = [...recolectar(entrada).entries()].sort(([a], [b]) => a.localeCompare(b));
  const cuerpos = modulos
    .map(([id, codigo]) => `  ${JSON.stringify(id)}: function (module, exports, require) {\n${codigo}\n  },`)
    .join('\n');
  return [
    'const __fuentes = {',
    cuerpos,
    '};',
    'const __cache = {};',
    'function __resolver(desde, ruta) {',
    "  const partes = desde.split('/').slice(0, -1);",
    "  for (const p of ruta.split('/')) {",
    "    if (p === '..') partes.pop();",
    "    else if (p !== '.') partes.push(p);",
    '  }',
    "  const id = partes.join('/');",
    "  return id.endsWith('.js') ? id : `${id}.js`;",
    '}',
    'function __cargar(id) {',
    '  if (__cache[id]) return __cache[id].exports;',
    '  const modulo = { exports: {} };',
    '  __cache[id] = modulo;',
    '  __fuentes[id](modulo, modulo.exports, (ruta) => __cargar(__resolver(id, ruta)));',
    '  return modulo.exports;',
    '}',
  ].join('\n');
}

module.exports = { empaquetar };
