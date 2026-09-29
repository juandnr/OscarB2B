'use strict';

// F2 — Análisis con Claude (cron cada 3 min).
//
//   Cron → [Postgres f2_tomar_pendientes] → analizar → [Postgres f2_guardar_resultados]
//
// Modo sombra (MODO_SOMBRA distinto de "false"): solo escribe resumen_ia y una
// nota con lo que habría hecho. Modo activo: mueve etapas, escribe propiedades,
// crea tareas y deja una nota cuando cambia algo.

const { preparar, escaparHtml, lista } = require('./comun');
const { claveDesdeId, idDesdeClave, etapa: datosEtapa } = require('../etapas');
const { vencimiento, PRIORIDAD, nombreCliente } = require('../tareas');
const { construirContexto, analizarConversacion } = require('../claude');
const { decidir } = require('../reglas');

function filaTarea(t) {
  return { hubspot_task_id: t.hubspot_task_id, tipo: t.tipo, vence_at: t.vence_at, hubspot_deal_id: t.hubspot_deal_id };
}

function etiqueta(clave) {
  return clave ? datosEtapa(clave).etiqueta : '—';
}

function notaHtml({ modoSombra, etapaActual, decision, analisis, tareasCreadas }) {
  const titulo = modoSombra ? 'Análisis IA (modo sombra: no se aplicó ningún cambio)' : 'Análisis IA';
  let movimiento;
  if (decision.negocioNuevo) {
    movimiento = `${modoSombra ? 'Habría abierto' : 'Se abrió'} un negocio nuevo en <b>${etiqueta(decision.negocioNuevo)}</b> (el anterior está en ${etiqueta(etapaActual)}).`;
  } else if (decision.etapaNueva) {
    movimiento = `${modoSombra ? 'Habría movido' : 'Se movió'} el negocio de <b>${etiqueta(etapaActual)}</b> a <b>${etiqueta(decision.etapaNueva)}</b>.`;
  } else {
    movimiento = `La etapa se mantiene en <b>${etiqueta(etapaActual)}</b>.`;
  }
  const tareas = (modoSombra ? decision.tareas : tareasCreadas).map((t) => escaparHtml(t.titulo));
  const datos = Object.entries(analisis.datos_pedido)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}: ${escaparHtml(v)}`);
  return [
    `<p><b>🤖 ${titulo}</b></p>`,
    `<p>Etapa detectada: <b>${escaparHtml(analisis.etapa_detectada)}</b> (confianza ${analisis.confianza})</p>`,
    `<p>Motivo: ${escaparHtml(analisis.motivo)}</p>`,
    `<p>${movimiento}</p>`,
    `<p>${modoSombra ? 'Tareas que habría creado' : 'Tareas creadas'}:</p>${lista(tareas)}`,
    datos.length ? `<p>Datos detectados:</p>${lista(datos)}` : '',
    decision.descartes.length ? `<p>Reglas aplicadas:</p>${lista(decision.descartes.map(escaparHtml))}` : '',
    `<p>Resumen: ${escaparHtml(analisis.resumen)}</p>`,
  ].join('');
}

async function analizarCliente(cliente, ctx, prep, parcial = { tareasCreadas: [] }) {
  const { config, hs, cal, ahora } = prep;
  const { pipelineId, etapas } = config.hubspot;
  const modo = config.modoSombra ? 'sombra' : 'activo';
  const base = { telefono: cliente.telefono, corte: cliente.corte };

  const negocio = await hs.leerNegocio(cliente.hubspot_deal_id);
  if (!negocio) {
    return { ...base, ok: true, limpiar_deal: true,
      analisis: { modo, hubspot_deal_id: cliente.hubspot_deal_id, error: 'El negocio ya no existe en HubSpot' } };
  }
  const p = negocio.properties;
  const etapaActual = p.pipeline === pipelineId ? claveDesdeId(p.dealstage, etapas) : null;
  if (!etapaActual) {
    return { ...base, ok: true,
      analisis: { modo, hubspot_deal_id: negocio.id, error: `El negocio no está en el pipeline configurado (etapa ${p.dealstage})` } };
  }
  const owner = p.hubspot_owner_id || cliente.vendedor_owner_id || null;
  const tareasAbiertas = cliente.tareas_abiertas || [];

  const contexto = construirContexto({
    cliente,
    etapaActual,
    datos: p,
    tareasAbiertas,
    mensajes: cliente.mensajes || [],
    ahora,
    tz: config.timezone,
  });
  const { analisis, usage, modelo } = await analizarConversacion({
    http: ctx.http, config, contexto, esperar: ctx.esperar,
  });
  const decision = decidir({ analisis, etapaActual, tareasAbiertas, cliente, datosActuales: p });

  let dealId = negocio.id;
  let etapaFinal = etapaActual;
  // Se registran a medida que se crean para no perderlas si algo falla después.
  const { tareasCreadas } = parcial;

  if (config.modoSombra) {
    await hs.actualizarNegocio(dealId, { resumen_ia: analisis.resumen });
  } else {
    const propiedades = { ...decision.propiedades };
    if (decision.negocioNuevo) {
      const nuevo = await hs.crearNegocio({
        ...propiedades,
        dealname: `${nombreCliente(cliente)} (WhatsApp)`,
        pipeline: pipelineId,
        dealstage: idDesdeClave(decision.negocioNuevo, etapas),
        hubspot_owner_id: owner,
        wa_telefono: cliente.telefono,
      }, cliente.hubspot_contact_id);
      dealId = nuevo.id;
      etapaFinal = decision.negocioNuevo;
      parcial.negocio = { hubspot_deal_id: String(dealId), etapa: etapaFinal };
    } else if (decision.etapaNueva) {
      propiedades.dealstage = idDesdeClave(decision.etapaNueva, etapas);
      etapaFinal = decision.etapaNueva;
    }

    const fechaEntrega = decision.propiedades.fecha_entrega || p.fecha_entrega || null;
    for (const t of decision.tareas) {
      const vence = vencimiento(t.tipo, {
        ahora, config, cal, fechaEntrega, ultimoMsgEmpresaAt: cliente.ultimo_msg_empresa_at,
      });
      const creada = await hs.crearTarea({
        asunto: t.titulo,
        cuerpo: `${t.detalle || ''}\n\nCreada por la IA. Motivo: ${analisis.motivo}`.trim(),
        vence,
        ownerId: owner,
        dealId,
        contactId: cliente.hubspot_contact_id,
        prioridad: PRIORIDAD[t.tipo],
      });
      tareasCreadas.push({
        ...t, hubspot_task_id: String(creada.id), vence_at: vence.toISOString(), hubspot_deal_id: String(dealId),
      });
    }

    // La etapa se mueve después de crear las tareas: si algo falla antes, el
    // reintento vuelve a detectar el avance y no se pierde la tarea de la etapa.
    if (!decision.negocioNuevo) await hs.actualizarNegocio(dealId, propiedades);
  }

  const huboCambios = decision.etapaNueva || decision.negocioNuevo || tareasCreadas.length;
  if (config.modoSombra || huboCambios) {
    await hs.crearNota({
      cuerpo: notaHtml({ modoSombra: config.modoSombra, etapaActual, decision, analisis, tareasCreadas }),
      dealId,
      contactId: cliente.hubspot_contact_id,
    });
  }

  return {
    ...base,
    ok: true,
    etapa: etapaFinal,
    hubspot_owner_id: owner,
    hubspot_deal_id: String(dealId),
    tareas_nuevas: tareasCreadas.map(filaTarea),
    analisis: {
      modo,
      hubspot_deal_id: String(dealId),
      etapa_antes: etapaActual,
      etapa_detectada: analisis.etapa_detectada,
      confianza: analisis.confianza,
      etapa_aplicada: config.modoSombra ? null : (decision.negocioNuevo || decision.etapaNueva),
      resultado: analisis,
      decision: {
        etapa_nueva: decision.etapaNueva,
        negocio_nuevo: decision.negocioNuevo,
        tareas: decision.tareas.map((t) => ({ tipo: t.tipo, titulo: t.titulo, origen: t.origen })),
        descartes: decision.descartes,
      },
      tokens: usage ? { ...usage, modelo } : null,
    },
  };
}

// Entrada: filas de f2_tomar_pendientes. Salida: un item { resultados: [...] }.
async function analizar(clientes, ctx) {
  const prep = preparar(ctx, ['hubspot', 'anthropic']);
  const inicio = Date.now();
  const resultados = [];
  for (const cliente of clientes) {
    // Con margen dentro del límite de tiempo del entorno (n8n: 300 s; Supabase: 150 s).
    if (Date.now() - inicio > prep.config.f2TiempoMaximoS * 1000) {
      resultados.push({ telefono: cliente.telefono, liberar: true });
      continue;
    }
    const parcial = { tareasCreadas: [] };
    try {
      resultados.push(await analizarCliente(cliente, ctx, prep, parcial));
    } catch (error) {
      resultados.push({
        telefono: cliente.telefono,
        ok: false,
        corte: cliente.corte,
        tareas_nuevas: parcial.tareasCreadas.map(filaTarea),
        ...(parcial.negocio || {}),
        analisis: {
          modo: prep.config.modoSombra ? 'sombra' : 'activo',
          hubspot_deal_id: cliente.hubspot_deal_id,
          etapa_antes: cliente.etapa,
          error: error.message,
        },
      });
    }
  }
  return [{ resultados }];
}

module.exports = { analizar, analizarCliente, notaHtml };
