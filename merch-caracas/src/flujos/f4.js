'use strict';

// F4 — Tareas completadas (cron cada 5 min).
//
//   Cron → [Postgres f4_tareas_abiertas] → procesar → [Postgres registrar_cambios]
//
// Lee en HubSpot las tareas que en Postgres siguen abiertas. Las completadas
// mueven el negocio según su tipo (solo hacia adelante) y crean la tarea de la
// etapa siguiente. "Pagado" solo se alcanza aquí, al completar "Verificar pago".
// La tarea "Iniciar producción" va a PRODUCCION_HUBSPOT_OWNER_ID si está
// definido; las demás, al dueño del negocio.

const { preparar, escaparHtml } = require('./comun');
const { claveDesdeId, idDesdeClave, esAvance, orden, etapa: datosEtapa } = require('../etapas');
const { tituloTarea, vencimiento, PRIORIDAD } = require('../tareas');

// tipo de tarea completada → etapa a la que pasa el negocio
const SIGUIENTE = {
  verificar_pago: 'pagado',
  produccion: 'listo_para_enviar',
  enviar: 'enviado',
  confirmar: 'entregado',
};

async function procesar(filas, ctx) {
  const { config, hs, cal, ahora } = preparar(ctx, ['hubspot']);
  const { etapas } = config.hubspot;
  const enHubspot = await hs.leerTareas(filas.map((f) => f.hubspot_task_id));
  const cambios = { clientes: [], tareas_nuevas: [], tareas_estado: [] };

  // Tareas que siguen abiertas por cliente, para no duplicar.
  const abiertas = {};
  const completadas = [];
  for (const f of filas) {
    const t = enHubspot[String(f.hubspot_task_id)];
    if (!t) {
      cambios.tareas_estado.push({ hubspot_task_id: f.hubspot_task_id, estado: 'eliminada' });
    } else if (t.properties.hs_task_status === 'COMPLETED') {
      cambios.tareas_estado.push({
        hubspot_task_id: f.hubspot_task_id,
        estado: 'completada',
        completada_at: t.properties.hs_task_completion_date || new Date(ahora).toISOString(),
      });
      if (SIGUIENTE[f.tipo]) completadas.push(f);
    } else {
      (abiertas[f.telefono] = abiertas[f.telefono] || new Set()).add(f.tipo);
    }
  }

  // Por negocio, en orden de etapa, para encadenar varias completadas en la misma corrida.
  completadas.sort((a, b) => orden(SIGUIENTE[a.tipo]) - orden(SIGUIENTE[b.tipo]));
  const estado = {};
  for (const f of completadas) {
    const dealId = String(f.tarea_deal_id || f.hubspot_deal_id);
    if (!estado[dealId]) {
      const negocio = await hs.leerNegocio(dealId);
      if (!negocio) continue;
      estado[dealId] = {
        etapa: claveDesdeId(negocio.properties.dealstage, etapas),
        props: negocio.properties,
      };
    }
    const actual = estado[dealId];
    if (!actual.etapa) continue; // fuera del pipeline configurado
    const destino = SIGUIENTE[f.tipo];
    const owner = actual.props.hubspot_owner_id || f.vendedor_owner_id || null;

    if (esAvance(actual.etapa, destino)) {
      await hs.actualizarNegocio(dealId, { dealstage: idDesdeClave(destino, etapas) });
      await hs.crearNota({
        cuerpo: `<p>Negocio movido de <b>${escaparHtml(datosEtapa(actual.etapa).etiqueta)}</b> a `
          + `<b>${escaparHtml(datosEtapa(destino).etiqueta)}</b> porque se completó la tarea "${escaparHtml(f.tipo)}".</p>`,
        dealId,
        contactId: f.hubspot_contact_id,
      });
      actual.etapa = destino;
    } else if (actual.etapa !== destino) {
      continue; // ya está más adelante (alguien lo movió a mano): no se toca
    }

    const tipo = datosEtapa(destino).tarea;
    const delCliente = (abiertas[f.telefono] = abiertas[f.telefono] || new Set());
    if (tipo && !delCliente.has(tipo)) {
      const cliente = { telefono: f.telefono, nombre_wa: f.nombre_wa };
      const vence = vencimiento(tipo, { ahora, config, cal, fechaEntrega: actual.props.fecha_entrega });
      const responsable = (tipo === 'produccion' && config.hubspot.produccionOwnerId) || owner;
      const tarea = await hs.crearTarea({
        asunto: tituloTarea(tipo, cliente, actual.props),
        cuerpo: `Creada al completar la tarea "${f.tipo}".`,
        vence,
        ownerId: responsable,
        dealId,
        contactId: f.hubspot_contact_id,
        prioridad: PRIORIDAD[tipo],
      });
      delCliente.add(tipo);
      cambios.tareas_nuevas.push({
        hubspot_task_id: String(tarea.id), telefono: f.telefono, tipo, vence_at: vence.toISOString(), hubspot_deal_id: dealId,
        hubspot_owner_id: responsable,
      });
    }
    if (dealId === String(f.hubspot_deal_id)) {
      cambios.clientes.push({ telefono: f.telefono, etapa: actual.etapa, hubspot_owner_id: owner });
    }
  }

  const hayCambios = cambios.tareas_estado.length || cambios.tareas_nuevas.length || cambios.clientes.length;
  return hayCambios ? [{ cambios }] : [];
}

module.exports = { procesar, SIGUIENTE };
