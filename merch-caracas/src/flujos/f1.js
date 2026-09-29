'use strict';

// F1 — Recepción (webhook de 360dialog, tiempo real).
//
//   Webhook → normalizar → [Postgres f1_registrar_mensajes]
//     ├→ buscarEnHubspot → [Postgres f1_asignar_vendedor] → crearEnHubspot → [Postgres registrar_cambios]
//     └→ completarRespondidas → [Postgres registrar_cambios]

const { preparar } = require('./comun');
const { normalizarWebhook, secretoValido } = require('../whatsapp');
const { claveDesdeId, esCerrada } = require('../etapas');
const { tituloTarea, vencimiento, nombreCliente } = require('../tareas');

// Entrada: items del nodo Webhook ({ headers, query, body }).
// Salida: un item { mensajes: [...] } o nada si no hay mensajes.
async function normalizar(entrada, ctx) {
  const { config } = preparar(ctx, ['webhook']);
  const mensajes = [];
  const avisos = [];
  for (const item of entrada) {
    if (!secretoValido(item, config.d360.webhookSecret)) {
      throw new Error('Webhook rechazado: el secreto no coincide con D360_WEBHOOK_SECRET');
    }
    const r = normalizarWebhook(item.body);
    mensajes.push(...r.mensajes);
    avisos.push(...r.ignorados);
  }
  return mensajes.length ? [{ mensajes, avisos }] : [];
}

// Entrada: filas de f1_registrar_mensajes. Para los clientes nuevos busca en
// HubSpot un negocio o contacto previo con ese teléfono.
// Salida: un item { asignaciones: [{telefono, hubspot_owner_id}], busquedas: {telefono: {...}} }
async function buscarEnHubspot(filas, ctx) {
  const nuevos = filas.filter((f) => f.necesita_alta);
  if (!nuevos.length) return [];
  const { config, hs } = preparar(ctx, ['hubspot', 'horario']);
  const { pipelineId, etapas } = config.hubspot;

  const asignaciones = [];
  const busquedas = {};
  for (const fila of nuevos) {
    let negocio = (await hs.buscarNegociosPorTelefono(fila.telefono, pipelineId))[0] || null;
    const contacto = await hs.buscarContactoPorTelefono(fila.telefono);
    if (!negocio && contacto) {
      negocio = (await hs.negociosDeContacto(contacto.id, pipelineId))[0] || null;
    }
    const etapaNegocio = negocio ? claveDesdeId(negocio.properties.dealstage, etapas) : null;
    const abierto = negocio && etapaNegocio && !esCerrada(etapaNegocio);
    // Spec: "si ya tenía negocio y propietario → reusar ese vendedor".
    const ownerPrevio = (negocio && negocio.properties.hubspot_owner_id) || null;

    asignaciones.push({ telefono: fila.telefono, hubspot_owner_id: ownerPrevio });
    busquedas[fila.telefono] = {
      nombre_wa: fila.nombre_wa,
      contacto_id: contacto ? contacto.id : null,
      contacto_owner_id: contacto ? contacto.properties.hubspot_owner_id || null : null,
      negocio_abierto_id: abierto ? negocio.id : null,
      negocio_abierto_etapa: abierto ? etapaNegocio : null,
      negocio_owner_id: abierto ? ownerPrevio : null,
      negocio_wa_telefono: abierto ? negocio.properties.wa_telefono || null : null,
    };
  }
  return [{ asignaciones, busquedas }];
}

// Entrada: filas de f1_asignar_vendedor. extra.busquedas viene de buscarEnHubspot.
// Crea contacto y negocio (si no existían) con el vendedor como propietario y
// la tarea "Contestar a {nombre}".
// Salida: un item con los cambios para registrar_cambios.
async function crearEnHubspot(asignados, ctx, extra) {
  const { config, hs, cal, ahora } = preparar(ctx, ['hubspot', 'horario']);
  const { pipelineId, etapas } = config.hubspot;
  const cambios = { clientes: [], tareas_nuevas: [] };

  for (const a of asignados) {
    const b = extra.busquedas[a.telefono];
    if (!b) throw new Error(`Sin datos de búsqueda para ${a.telefono}`);
    const cliente = { telefono: a.telefono, nombre_wa: b.nombre_wa };
    const nombre = nombreCliente(cliente);
    const owner = a.hubspot_owner_id;

    let contactId = b.contacto_id;
    if (!contactId) {
      const propiedades = { phone: a.telefono, hubspot_owner_id: owner };
      if (b.nombre_wa) propiedades.firstname = b.nombre_wa;
      contactId = (await hs.crearContacto(propiedades)).id;
    } else if (!b.contacto_owner_id) {
      await hs.actualizarContacto(contactId, { hubspot_owner_id: owner });
    }

    let dealId = b.negocio_abierto_id;
    let etapa = b.negocio_abierto_etapa;
    if (!dealId) {
      const negocio = await hs.crearNegocio({
        dealname: `${nombre} (WhatsApp)`,
        pipeline: pipelineId,
        dealstage: etapas.nuevo,
        hubspot_owner_id: owner,
        wa_telefono: a.telefono,
      }, contactId);
      dealId = negocio.id;
      etapa = 'nuevo';
    } else {
      // Negocio abierto encontrado: se le pone el teléfono si no lo tenía y, si el
      // propietario previo no es un vendedor de la rotación, pasa al asignado.
      const propiedades = {};
      if (b.negocio_owner_id !== owner) propiedades.hubspot_owner_id = owner;
      if (b.negocio_wa_telefono !== a.telefono) propiedades.wa_telefono = a.telefono;
      if (Object.keys(propiedades).length) await hs.actualizarNegocio(dealId, propiedades);
    }

    const vence = vencimiento('contestar', { ahora, config, cal });
    const tarea = await hs.crearTarea({
      asunto: tituloTarea('contestar', cliente),
      cuerpo: `Mensaje nuevo de WhatsApp de ${a.telefono}. Asignado a ${a.vendedor_nombre} (${a.metodo}).`,
      vence,
      ownerId: owner,
      dealId,
      contactId,
      prioridad: 'HIGH',
    });

    cambios.clientes.push({
      telefono: a.telefono,
      hubspot_contact_id: String(contactId),
      hubspot_deal_id: String(dealId),
      etapa,
      hubspot_owner_id: owner,
      alta_completa: true,
    });
    cambios.tareas_nuevas.push({
      hubspot_task_id: String(tarea.id),
      telefono: a.telefono,
      tipo: 'contestar',
      vence_at: vence.toISOString(),
      hubspot_deal_id: String(dealId),
    });
  }
  return [{ cambios }];
}

// Entrada: filas de f1_registrar_mensajes. Completa en HubSpot las tareas
// "contestar" que ya fueron respondidas desde la app.
async function completarRespondidas(filas, ctx) {
  const ids = filas.flatMap((f) => f.tareas_contestar_completar || []);
  if (!ids.length) return [];
  const { hs } = preparar(ctx, ['hubspot']);
  const tareas_estado = [];
  for (const id of ids) {
    const r = await hs.completarTarea(id);
    tareas_estado.push({ hubspot_task_id: id, estado: r ? 'completada' : 'eliminada' });
  }
  return [{ cambios: { tareas_estado } }];
}

module.exports = { normalizar, buscarEnHubspot, crearEnHubspot, completarRespondidas };
