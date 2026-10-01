'use strict';

// Etapas del pipeline "Ventas" en orden. `tarea` es el tipo de tarea que
// se crea al entrar a la etapa. `probabilidad` la exige HubSpot para cada etapa
// de negocio (se puede ajustar luego en HubSpot sin tocar el código).
const ETAPAS = [
  { clave: 'nuevo',             etiqueta: 'Nuevo',                  orden: 1, tarea: 'contestar',      probabilidad: 0.1 },
  { clave: 'solicitud',         etiqueta: 'Solicitud',              orden: 2, tarea: 'cotizar',        probabilidad: 0.2 },
  { clave: 'cotizado',          etiqueta: 'Cotizado',               orden: 3, tarea: 'seguimiento',    probabilidad: 0.4 },
  { clave: 'verificar_pago',    etiqueta: 'Verificar pago',         orden: 4, tarea: 'verificar_pago', probabilidad: 0.7 },
  { clave: 'pagado',            etiqueta: 'Pagado / En producción', orden: 5, tarea: 'produccion',     probabilidad: 0.9 },
  { clave: 'listo_para_enviar', etiqueta: 'Listo para enviar',      orden: 6, tarea: 'enviar',         probabilidad: 0.9 },
  { clave: 'enviado',           etiqueta: 'Enviado',                orden: 7, tarea: 'confirmar',      probabilidad: 0.95 },
  { clave: 'entregado',         etiqueta: 'Entregado',              orden: 8, tarea: null,             probabilidad: 1.0, cerrada: true, ganada: true },
  { clave: 'perdido',           etiqueta: 'Perdido',                orden: 9, tarea: null,             probabilidad: 0.0, cerrada: true },
];

const CLAVES_ETAPA = ETAPAS.map((e) => e.clave);

const POR_CLAVE = Object.fromEntries(ETAPAS.map((e) => [e.clave, e]));

const MOTIVOS_PERDIDA = [
  'No respondió',
  'Precio fuera de presupuesto',
  'Compró en otro lado',
  'No era cliente (spam/equivocado)',
  'Duplicado',
  'Otro',
];

function etapa(clave) {
  const e = POR_CLAVE[clave];
  if (!e) throw new Error(`Etapa desconocida: ${clave}`);
  return e;
}

function orden(clave) {
  return etapa(clave).orden;
}

function esCerrada(clave) {
  return Boolean(etapa(clave).cerrada);
}

// ¿Pasar de `actual` a `nueva` es avanzar? Nunca desde una etapa cerrada.
function esAvance(actual, nueva) {
  if (esCerrada(actual)) return false;
  if (nueva === 'perdido') return false;
  return orden(nueva) > orden(actual);
}

// mapa = { nuevo: '<id HubSpot>', ... } (config.hubspot.etapas)
function claveDesdeId(id, mapa) {
  for (const [clave, valor] of Object.entries(mapa)) {
    if (String(valor) === String(id)) return clave;
  }
  return null;
}

function idDesdeClave(clave, mapa) {
  const id = mapa[clave];
  if (!id) throw new Error(`Falta el ID de HubSpot para la etapa "${clave}"`);
  return id;
}

module.exports = {
  ETAPAS,
  CLAVES_ETAPA,
  MOTIVOS_PERDIDA,
  etapa,
  orden,
  esCerrada,
  esAvance,
  claveDesdeId,
  idDesdeClave,
};
