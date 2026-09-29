'use strict';

// Llamada a la API de Claude para F2: arma la solicitud, interpreta la respuesta
// y valida el JSON contra el contrato.

const SISTEMA = require('./prompt');
const { partesLocales } = require('./horario');

const ETAPAS_DETECTABLES = [
  'nuevo', 'solicitud', 'cotizado', 'verificar_pago', 'listo_para_enviar', 'enviado', 'entregado', 'sin_cambio',
];
const TIPOS_TAREA_CLAUDE = ['contestar', 'cotizar', 'seguimiento', 'verificar_pago', 'enviar', 'confirmar'];

const texto = { type: 'string' };
const nulo = { type: 'null' };

// Esquema de salidas estructuradas: la API garantiza un JSON con esta forma.
const ESQUEMA = {
  type: 'object',
  properties: {
    etapa_detectada: { type: 'string', enum: ETAPAS_DETECTABLES },
    confianza: { type: 'number' },
    motivo: texto,
    datos_pedido: {
      type: 'object',
      properties: {
        producto: { anyOf: [texto, nulo] },
        cantidad: { anyOf: [{ type: 'number' }, nulo] },
        fecha_entrega: { anyOf: [{ type: 'string', format: 'date' }, nulo] },
        empresa_cliente: { anyOf: [texto, nulo] },
      },
      required: ['producto', 'cantidad', 'fecha_entrega', 'empresa_cliente'],
      additionalProperties: false,
    },
    tareas_nuevas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: TIPOS_TAREA_CLAUDE },
          titulo: texto,
          detalle: texto,
        },
        required: ['tipo', 'titulo', 'detalle'],
        additionalProperties: false,
      },
    },
    resumen: texto,
  },
  required: ['etapa_detectada', 'confianza', 'motivo', 'datos_pedido', 'tareas_nuevas', 'resumen'],
  additionalProperties: false,
};

class ErrorClaude extends Error {
  constructor(tipo, mensaje, detalle) {
    super(mensaje);
    this.tipo = tipo;           // http | rechazo | max_tokens | json_invalido
    this.detalle = detalle;
  }
}

function fechaLocal(fecha, tz) {
  const p = partesLocales(new Date(fecha), tz);
  const dos = (n) => String(n).padStart(2, '0');
  return `${p.anio}-${dos(p.mes)}-${dos(p.dia)} ${dos(p.hora)}:${dos(p.minuto)}`;
}

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// Mensaje de usuario con el contexto variable. El prompt del sistema queda fijo
// para que la caché de prompt funcione entre clientes.
function construirContexto({ cliente, etapaActual, datos, tareasAbiertas, mensajes, ahora, tz }) {
  const lineas = mensajes.map((m) => {
    const quien = m.direccion === 'entrante' ? 'CLIENTE' : 'VENDEDOR';
    const contenido = (m.texto && String(m.texto).trim()) || `[${m.tipo}]`;
    return `[${fechaLocal(m.ts, tz)}] ${quien}: ${contenido}`;
  });
  const registrados = ['producto', 'cantidad', 'fecha_entrega', 'empresa_cliente']
    .map((k) => `${k}: ${datos && datos[k] != null && datos[k] !== '' ? datos[k] : 'sin dato'}`)
    .join('; ');
  const tareas = tareasAbiertas.length ? [...new Set(tareasAbiertas.map((t) => t.tipo))].join(', ') : 'ninguna';
  const diaSemana = DIAS_SEMANA[partesLocales(new Date(ahora), tz).diaSemana];
  return [
    `Fecha y hora actual: ${diaSemana} ${fechaLocal(ahora, tz)} (${tz})`,
    `Etapa actual del negocio: ${etapaActual}`,
    `Datos registrados: ${registrados}`,
    `Tareas abiertas: ${tareas}`,
    `Nombre del cliente en WhatsApp: ${(cliente.nombre_wa && cliente.nombre_wa.trim()) || 'desconocido'}`,
    '',
    `Conversación (${mensajes.length} mensajes, del más antiguo al más reciente):`,
    '<conversacion>',
    ...lineas,
    '</conversacion>',
  ].join('\n');
}

function construirSolicitud(config, contexto) {
  const a = config.anthropic;
  const body = {
    model: a.modelo,
    max_tokens: 8000,
    system: [{ type: 'text', text: SISTEMA, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: contexto }],
    output_config: { effort: a.esfuerzo, format: { type: 'json_schema', schema: ESQUEMA } },
  };
  const headers = {
    'x-api-key': a.apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  if (a.fallback === 'default') {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }
  return { method: 'POST', url: `${a.apiUrl}/v1/messages`, headers, body };
}

function esFecha(valor) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const [a, m, d] = valor.split('-').map(Number);
  const f = new Date(Date.UTC(a, m - 1, d));
  return f.getUTCFullYear() === a && f.getUTCMonth() === m - 1 && f.getUTCDate() === d;
}

function textoONulo(valor) {
  if (valor === null || valor === undefined) return null;
  const t = String(valor).trim();
  return t ? t : null;
}

// Valida y normaliza el JSON de Claude. Lanza ErrorClaude('json_invalido') si no cumple.
function validarAnalisis(obj) {
  const errores = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ErrorClaude('json_invalido', 'La respuesta no es un objeto JSON');
  }
  if (!ETAPAS_DETECTABLES.includes(obj.etapa_detectada)) errores.push(`etapa_detectada inválida: ${obj.etapa_detectada}`);
  const confianza = Number(obj.confianza);
  if (obj.confianza === null || obj.confianza === '' || !Number.isFinite(confianza) || confianza < 0 || confianza > 1) {
    errores.push(`confianza inválida: ${obj.confianza}`);
  }
  if (typeof obj.motivo !== 'string') errores.push('motivo debe ser texto');
  if (typeof obj.resumen !== 'string') errores.push('resumen debe ser texto');

  const d = obj.datos_pedido;
  const datos = { producto: null, cantidad: null, fecha_entrega: null, empresa_cliente: null };
  if (!d || typeof d !== 'object' || Array.isArray(d)) {
    errores.push('datos_pedido debe ser un objeto');
  } else {
    datos.producto = textoONulo(d.producto);
    datos.empresa_cliente = textoONulo(d.empresa_cliente);
    if (d.cantidad !== null && d.cantidad !== undefined) {
      const n = Number(d.cantidad);
      if (Number.isFinite(n) && n > 0) datos.cantidad = n;
      else errores.push(`cantidad inválida: ${d.cantidad}`);
    }
    if (d.fecha_entrega !== null && d.fecha_entrega !== undefined) {
      if (esFecha(d.fecha_entrega)) datos.fecha_entrega = d.fecha_entrega;
      else errores.push(`fecha_entrega inválida: ${d.fecha_entrega}`);
    }
  }

  const tareas = [];
  if (!Array.isArray(obj.tareas_nuevas)) {
    errores.push('tareas_nuevas debe ser una lista');
  } else {
    for (const t of obj.tareas_nuevas) {
      if (!t || !TIPOS_TAREA_CLAUDE.includes(t.tipo)) {
        errores.push(`tipo de tarea inválido: ${t && t.tipo}`);
      } else if (typeof t.titulo !== 'string' || !t.titulo.trim()) {
        errores.push('tarea sin título');
      } else {
        tareas.push({ tipo: t.tipo, titulo: t.titulo.trim(), detalle: typeof t.detalle === 'string' ? t.detalle.trim() : '' });
      }
    }
  }

  if (errores.length) throw new ErrorClaude('json_invalido', `JSON inválido: ${errores.join('; ')}`, obj);
  return {
    etapa_detectada: obj.etapa_detectada,
    confianza,
    motivo: obj.motivo.trim(),
    datos_pedido: datos,
    tareas_nuevas: tareas,
    resumen: obj.resumen.trim(),
  };
}

// Extrae y valida el JSON de una respuesta 200 de /v1/messages.
function interpretarRespuesta(body) {
  if (!body || !Array.isArray(body.content)) {
    throw new ErrorClaude('json_invalido', 'Respuesta de Claude sin contenido', body);
  }
  if (body.stop_reason === 'refusal') {
    const categoria = body.stop_details && body.stop_details.category;
    throw new ErrorClaude('rechazo', `Claude rechazó la solicitud${categoria ? ` (${categoria})` : ''}`, body.stop_details);
  }
  if (body.stop_reason === 'max_tokens') {
    throw new ErrorClaude('max_tokens', 'La respuesta de Claude se cortó por max_tokens');
  }
  const crudo = body.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const limpio = crudo.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let obj;
  try {
    obj = JSON.parse(limpio);
  } catch (error) {
    throw new ErrorClaude('json_invalido', `No se pudo leer el JSON: ${error.message}`, crudo.slice(0, 500));
  }
  return validarAnalisis(obj);
}

// Hace la llamada con reintentos ante 429/5xx/529 o fallas de red.
async function llamarClaude({ http, config, contexto, esperar }) {
  const pausa = esperar || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const solicitud = construirSolicitud(config, contexto);
  let intento = 0;
  for (;;) {
    intento += 1;
    let r;
    try {
      r = await http({ ...solicitud, timeout: 120000 });
    } catch (error) {
      if (intento < 3) {
        await pausa(2000 * intento);
        continue;
      }
      throw new ErrorClaude('http', `Error de red con la API de Claude: ${error.message}`);
    }
    if (r.status === 200) {
      return { analisis: interpretarRespuesta(r.body), usage: r.body.usage || null, modelo: r.body.model || null };
    }
    if ((r.status === 429 || r.status >= 500) && intento < 3) {
      const reintentar = Number(r.headers && r.headers['retry-after']);
      await pausa(Number.isFinite(reintentar) && reintentar > 0 ? reintentar * 1000 : 3000 * intento);
      continue;
    }
    const detalle = r.body && r.body.error ? `${r.body.error.type}: ${r.body.error.message}` : JSON.stringify(r.body);
    throw new ErrorClaude('http', `API de Claude → ${r.status}: ${detalle}`);
  }
}

// Spec F2.4: si el JSON es inválido se reintenta una vez.
async function analizarConversacion(opciones) {
  try {
    return await llamarClaude(opciones);
  } catch (error) {
    if (error instanceof ErrorClaude && (error.tipo === 'json_invalido' || error.tipo === 'max_tokens')) {
      return llamarClaude(opciones);
    }
    throw error;
  }
}

module.exports = {
  ESQUEMA,
  ETAPAS_DETECTABLES,
  TIPOS_TAREA_CLAUDE,
  ErrorClaude,
  construirContexto,
  construirSolicitud,
  validarAnalisis,
  interpretarRespuesta,
  llamarClaude,
  analizarConversacion,
};
