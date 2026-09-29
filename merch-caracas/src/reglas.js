'use strict';

// Reglas de negocio de F2: convierten el análisis de Claude en acciones.
//   - El pipeline solo avanza; nunca retrocede ni sobrescribe una etapa posterior.
//   - La IA nunca pasa un negocio a Pagado (ni más allá sin pasar por Pagado):
//     lo más lejos que llega antes del pago es "verificar_pago".
//   - Confianza < 0.7 → sin cambio de etapa y sin tareas nuevas.
//   - No se duplica una tarea abierta del mismo tipo.

const { etapa, orden, esCerrada, esAvance } = require('./etapas');
const { tituloTarea, tareaPermitida } = require('./tareas');

const CONFIANZA_MINIMA = 0.7;

function sinNulos(obj) {
  const salida = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== null && v !== undefined && v !== '') salida[k] = v;
  }
  return salida;
}

// entrada: { analisis (validado), etapaActual, tareasAbiertas: [{tipo}], cliente: {nombre_wa, telefono},
//            datosActuales: {producto, cantidad, fecha_entrega, empresa_cliente} }
function decidir({ analisis, etapaActual, tareasAbiertas = [], cliente, datosActuales = {} }) {
  const descartes = [];
  const confiable = analisis.confianza >= CONFIANZA_MINIMA;
  let detectada = analisis.etapa_detectada;

  if (!confiable) {
    if (detectada !== 'sin_cambio') descartes.push(`confianza ${analisis.confianza} < ${CONFIANZA_MINIMA}: se ignora la etapa "${detectada}"`);
    if (analisis.tareas_nuevas.length) descartes.push('tareas sugeridas ignoradas por confianza baja');
    detectada = 'sin_cambio';
  }

  let etapaNueva = null;
  let negocioNuevo = null;
  if (detectada !== 'sin_cambio') {
    if (esCerrada(etapaActual)) {
      if (detectada === 'nuevo' || detectada === 'solicitud') {
        negocioNuevo = detectada;
      } else {
        descartes.push(`el negocio está cerrado (${etapaActual}); "${detectada}" no abre un negocio nuevo`);
      }
    } else {
      let objetivo = detectada;
      if (orden(etapaActual) < orden('pagado') && orden(objetivo) > orden('pagado')) {
        descartes.push(`"${detectada}" implica un pago que nadie ha verificado: se usa "verificar_pago"`);
        objetivo = 'verificar_pago';
      }
      if (esAvance(etapaActual, objetivo)) {
        etapaNueva = objetivo;
      } else if (objetivo !== etapaActual) {
        descartes.push(`no se retrocede de "${etapaActual}" a "${objetivo}"`);
      }
    }
  }

  const etapaFinal = negocioNuevo || etapaNueva || etapaActual;
  const datos = { ...sinNulos(datosActuales), ...sinNulos(analisis.datos_pedido) };

  const abiertas = new Set(tareasAbiertas.map((t) => t.tipo));
  const tareas = [];
  const agregar = (tipo, titulo, detalle, origen) => {
    if (tareas.some((t) => t.tipo === tipo)) return;
    if (abiertas.has(tipo)) {
      descartes.push(`ya hay una tarea "${tipo}" abierta`);
      return;
    }
    if (!tareaPermitida(tipo, etapaFinal)) {
      descartes.push(`la tarea "${tipo}" no aplica con el negocio en "${etapaFinal}"`);
      return;
    }
    tareas.push({ tipo, titulo, detalle, origen });
  };

  if (etapaNueva || negocioNuevo) {
    const tipo = etapa(etapaFinal).tarea;
    if (tipo) {
      const sugerida = analisis.tareas_nuevas.find((t) => t.tipo === tipo);
      agregar(tipo, tituloTarea(tipo, cliente, datos), sugerida ? sugerida.detalle : analisis.motivo, 'etapa');
    }
  }
  if (confiable) {
    for (const t of analisis.tareas_nuevas) agregar(t.tipo, t.titulo, t.detalle, 'claude');
  }

  return {
    etapaNueva,
    negocioNuevo,
    etapaFinal,
    tareas,
    propiedades: { ...sinNulos(analisis.datos_pedido), resumen_ia: analisis.resumen },
    descartes,
  };
}

module.exports = { decidir, CONFIANZA_MINIMA };
