'use strict';

// F3 — Tiempos de respuesta (cron cada 15 min; solo actúa en horario laboral).
//
//   Cron → [Postgres f3_estado] → revisar → [Postgres registrar_cambios]
//
// - Cliente con mensaje sin respuesta por más del SLA (minutos laborables) y sin
//   tarea "contestar" abierta → crea "Contestar a {nombre}" (vence ya).
//   SLA: SLA_RESPUESTA_NUEVO_MIN si el negocio está en Nuevo; si no, SLA_RESPUESTA_CURSO_MIN.
// - Tarea "contestar" vencida hace más de ESCALAR_MIN (laborables) → nota en el
//   negocio + tarea al administrador. Se escala una sola vez por tarea.
// - Tarea "contestar" abierta de un cliente que ya fue respondido → se completa.

const { preparar, escaparHtml } = require('./comun');
const { claveDesdeId } = require('../etapas');
const { tituloTarea, vencimiento, nombreCliente } = require('../tareas');
const { minutosLaborablesEntre, enHorarioLaboral } = require('../horario');

// Negocios perdidos por estos motivos no generan tareas de respuesta.
const MOTIVOS_SIN_RESPUESTA = ['No era cliente (spam/equivocado)', 'Duplicado'];

async function revisar(filas, ctx) {
  const { config, hs, cal, ahora } = preparar(ctx, ['hubspot', 'horario']);
  const tz = config.timezone;
  if (!enHorarioLaboral(ahora, cal, tz)) return [];

  const negocios = await hs.leerNegocios(filas.map((f) => f.hubspot_deal_id));
  const cambios = { clientes: [], tareas_nuevas: [], tareas_estado: [] };

  for (const fila of filas) {
    const negocio = negocios[String(fila.hubspot_deal_id)];
    if (!negocio) continue;
    const p = negocio.properties;
    const etapa = claveDesdeId(p.dealstage, config.hubspot.etapas) || fila.etapa;
    const owner = p.hubspot_owner_id || fila.vendedor_owner_id || null;
    cambios.clientes.push({ telefono: fila.telefono, etapa, hubspot_owner_id: owner });
    const tareas = fila.tareas_contestar || [];

    if (!fila.sin_respuesta) {
      for (const t of tareas) {
        const r = await hs.completarTarea(t.hubspot_task_id);
        cambios.tareas_estado.push({ hubspot_task_id: t.hubspot_task_id, estado: r ? 'completada' : 'eliminada' });
      }
      continue;
    }
    if (etapa === 'perdido' && MOTIVOS_SIN_RESPUESTA.includes(p.motivo_perdida)) continue;

    const cliente = { telefono: fila.telefono, nombre_wa: fila.nombre_wa };
    const espera = minutosLaborablesEntre(fila.ultimo_msg_cliente_at, ahora, cal, tz);
    const sla = etapa === 'nuevo' ? config.slaNuevoMin : config.slaCursoMin;

    if (!tareas.length && espera > sla) {
      const vence = vencimiento('contestar', { ahora, config, cal, inmediata: true });
      const tarea = await hs.crearTarea({
        asunto: tituloTarea('contestar', cliente),
        cuerpo: `El cliente escribió hace ${Math.round(espera)} min laborables y no ha recibido respuesta (SLA ${sla} min).`,
        vence,
        ownerId: owner,
        dealId: fila.hubspot_deal_id,
        contactId: fila.hubspot_contact_id,
        prioridad: 'HIGH',
      });
      cambios.tareas_nuevas.push({
        hubspot_task_id: String(tarea.id),
        telefono: fila.telefono,
        tipo: 'contestar',
        vence_at: vence.toISOString(),
        hubspot_deal_id: String(fila.hubspot_deal_id),
      });
    }

    for (const t of tareas) {
      if (t.escalada_at || !t.vence_at) continue;
      const vencida = minutosLaborablesEntre(t.vence_at, ahora, cal, tz);
      if (vencida <= config.escalarMin) continue;
      const vendedor = fila.vendedor_nombre || 'el vendedor asignado';
      const nombre = nombreCliente(cliente);
      await hs.crearNota({
        cuerpo: `<p><b>⚠️ Escalado:</b> ${escaparHtml(vendedor)} no ha contestado a ${escaparHtml(nombre)}. `
          + `La tarea "Contestar" lleva ${Math.round(vencida)} min laborables vencida.</p>`,
        dealId: fila.hubspot_deal_id,
        contactId: fila.hubspot_contact_id,
      });
      if (config.hubspot.adminOwnerId) {
        await hs.crearTarea({
          asunto: `Escalado: ${vendedor} no ha contestado a ${nombre}`,
          cuerpo: `Cliente ${fila.telefono}. La tarea "Contestar" lleva ${Math.round(vencida)} min laborables vencida.`,
          vence: ahora,
          ownerId: config.hubspot.adminOwnerId,
          dealId: fila.hubspot_deal_id,
          contactId: fila.hubspot_contact_id,
          prioridad: 'HIGH',
        });
      }
      cambios.tareas_estado.push({ hubspot_task_id: t.hubspot_task_id, escalada_at: new Date(ahora).toISOString() });
    }
  }
  return [{ cambios }];
}

module.exports = { revisar };
