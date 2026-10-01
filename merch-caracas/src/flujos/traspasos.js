'use strict';

// Traspasos de clientes (dentro de F4, cada 5 min).
//
//   [Postgres f4_clientes_abiertos] → revisar → [Postgres registrar_cambios]
//
// Un vendedor le pasa un cliente a otro cambiando en HubSpot el propietario del
// negocio. Al detectar el cambio (propietario actual ≠ último visto):
//   - las tareas abiertas del vendedor anterior para ese cliente pasan al nuevo
//     (salvo "Iniciar producción" si hay responsable fijo de producción);
//   - el contacto pasa al nuevo vendedor;
//   - el nuevo vendedor recibe una tarea de aviso y queda una nota en el negocio;
//   - el traspaso se registra para el resumen diario del administrador.
// La primera vez que se ve un negocio solo se anota su propietario.

const { preparar, escaparHtml, lista } = require('./comun');
const { nombreCliente } = require('../tareas');

const NOMBRE_TAREA = {
  contestar: 'Contestar',
  cotizar: 'Enviar cotización',
  seguimiento: 'Seguimiento de cotización',
  verificar_pago: 'Verificar pago',
  produccion: 'Iniciar producción',
  enviar: 'Enviar pedido',
  confirmar: 'Confirmar recepción',
};

async function revisar(filas, ctx) {
  if (!filas.length) return [];
  const { config, hs, ahora } = preparar(ctx, ['hubspot']);
  const negocios = await hs.leerNegocios(filas.map((f) => f.hubspot_deal_id), ['dealname', 'hubspot_owner_id']);
  const cambios = { clientes: [], tareas_estado: [], traspasos: [] };

  // Nombres de los usuarios de HubSpot; solo se piden si hay algún traspaso.
  let propietarios = null;
  const nombre = async (id) => {
    if (!propietarios) {
      propietarios = {};
      try {
        for (const o of await hs.listarPropietarios()) {
          propietarios[String(o.id)] = [o.firstName, o.lastName].filter(Boolean).join(' ').trim() || o.email;
        }
      } catch (error) {
        // sin el permiso de usuarios se muestran los IDs
      }
    }
    return propietarios[String(id)] || `usuario ${id}`;
  };

  for (const f of filas) {
    const negocio = negocios[String(f.hubspot_deal_id)];
    if (!negocio) continue;
    const actual = negocio.properties.hubspot_owner_id ? String(negocio.properties.hubspot_owner_id) : null;
    const visto = f.hubspot_owner_visto ? String(f.hubspot_owner_visto) : null;
    if (!actual || actual === visto) continue;

    if (!visto) {
      cambios.clientes.push({ telefono: f.telefono, hubspot_owner_id: actual, hubspot_owner_visto: actual });
      continue;
    }

    // ── Traspaso de `visto` a `actual` ──
    const cliente = nombreCliente({ telefono: f.telefono, nombre_wa: f.nombre_wa });
    const deNombre = await nombre(visto);
    const aNombre = await nombre(actual);

    const abiertas = f.tareas_abiertas || [];
    const enHubspot = abiertas.length ? await hs.leerTareas(abiertas.map((t) => t.hubspot_task_id)) : {};
    const movidas = [];
    for (const t of abiertas) {
      const h = enHubspot[String(t.hubspot_task_id)];
      if (!h || h.properties.hs_task_status === 'COMPLETED') continue;
      if (String(h.properties.hubspot_owner_id || '') !== visto) continue; // es de otra persona
      if (t.tipo === 'produccion' && config.hubspot.produccionOwnerId) continue;
      await hs.actualizarTarea(t.hubspot_task_id, { hubspot_owner_id: actual });
      cambios.tareas_estado.push({ hubspot_task_id: t.hubspot_task_id, hubspot_owner_id: actual });
      movidas.push(h.properties.hs_task_subject || NOMBRE_TAREA[t.tipo] || t.tipo);
    }

    if (f.hubspot_contact_id) await hs.actualizarContacto(f.hubspot_contact_id, { hubspot_owner_id: actual });

    const detalle = movidas.length
      ? `<p>Se te pasaron ${movidas.length} tarea(s) pendiente(s):</p>${lista(movidas.map(escaparHtml))}`
      : '<p>No tenía tareas pendientes.</p>';
    await hs.crearTarea({
      asunto: `Cliente transferido: ${cliente} (antes de ${deNombre})`,
      cuerpo: `<p>${escaparHtml(cliente)} (${escaparHtml(f.telefono)}) era de ${escaparHtml(deNombre)} y ahora es tuyo.</p>${detalle}`,
      vence: ahora,
      ownerId: actual,
      dealId: f.hubspot_deal_id,
      contactId: f.hubspot_contact_id,
      prioridad: 'HIGH',
    });
    await hs.crearNota({
      cuerpo: `<p><b>Traspaso:</b> ${escaparHtml(cliente)} pasó de <b>${escaparHtml(deNombre)}</b> a `
        + `<b>${escaparHtml(aNombre)}</b>. Tareas pendientes pasadas: ${movidas.length}.</p>`,
      dealId: f.hubspot_deal_id,
      contactId: f.hubspot_contact_id,
    });

    cambios.clientes.push({ telefono: f.telefono, hubspot_owner_id: actual, hubspot_owner_visto: actual });
    cambios.traspasos.push({
      telefono: f.telefono,
      hubspot_deal_id: String(f.hubspot_deal_id),
      de_owner_id: visto,
      a_owner_id: actual,
      de_nombre: deNombre,
      a_nombre: aNombre,
      tareas_movidas: movidas.length,
    });
  }

  return cambios.clientes.length ? [{ cambios }] : [];
}

module.exports = { revisar };
