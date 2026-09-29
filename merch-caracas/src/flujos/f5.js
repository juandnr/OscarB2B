'use strict';

// F5 — Resumen diario para el administrador (cron 7:30 a. m.).
//
//   Cron → [Postgres f5_datos] → resumir
//
// Crea una tarea en HubSpot asignada a ADMIN_HUBSPOT_OWNER_ID con el resumen
// en el cuerpo (le llega a la app móvil como cualquier tarea).

const { preparar, escaparHtml, lista } = require('./comun');
const { ETAPAS } = require('../etapas');
const { partesLocales } = require('../horario');

function fechaCorta(fecha, tz) {
  const p = partesLocales(new Date(fecha), tz);
  const dos = (n) => String(n).padStart(2, '0');
  return `${dos(p.dia)}/${dos(p.mes)} ${dos(p.hora)}:${dos(p.minuto)}`;
}

function horasDesde(fecha, ahora) {
  return Math.max(0, Math.round((new Date(ahora) - new Date(fecha)) / 3600000));
}

async function resumir(filas, ctx) {
  const { config, hs, ahora } = preparar(ctx, ['hubspot', 'admin']);
  const { pipelineId, etapas } = config.hubspot;
  const tz = config.timezone;
  const datos = (filas[0] && filas[0].datos) || {};
  const enPipeline = { propertyName: 'pipeline', operator: 'EQ', value: pipelineId };

  // Nombres de los propietarios (si la app no tiene el permiso de owners, se muestran los IDs).
  const propietarios = {};
  try {
    for (const o of await hs.listarPropietarios()) {
      propietarios[o.id] = [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email;
    }
  } catch (error) {
    // se sigue sin nombres
  }
  const nombreOwner = (id) => (id ? propietarios[id] || `propietario ${id}` : 'sin propietario');

  const porEtapa = [];
  for (const e of ETAPAS) {
    const total = await hs.contarNegocios([enPipeline, { propertyName: 'dealstage', operator: 'EQ', value: etapas[e.clave] }]);
    porEtapa.push(`${escaparHtml(e.etiqueta)}: <b>${total}</b>`);
  }

  const cotizaciones = await hs.listarNegocios(
    [enPipeline, { propertyName: 'dealstage', operator: 'EQ', value: etapas.cotizado }],
    ['dealname', 'hubspot_owner_id', 'producto', 'cantidad', 'hs_lastmodifieddate'],
    50,
  );
  const desde = new Date(ahora).getTime() - 24 * 3600000;
  // Perdidos en las últimas 24 h (negocios en Perdido modificados en ese lapso).
  const perdidos = await hs.listarNegocios(
    [
      enPipeline,
      { propertyName: 'dealstage', operator: 'EQ', value: etapas.perdido },
      { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(desde) },
    ],
    ['dealname', 'hubspot_owner_id', 'motivo_perdida'],
    100,
  );

  const sinResponder = (datos.sin_responder || []).map((c) =>
    `${escaparHtml(c.nombre || c.telefono)} (${escaparHtml(c.vendedor || 'sin vendedor')}) — esperando desde ${fechaCorta(c.desde, tz)}, ${horasDesde(c.desde, ahora)} h`);

  const vencidasPorVendedor = {};
  for (const t of datos.tareas_vencidas || []) {
    const v = t.vendedor || 'sin vendedor';
    (vencidasPorVendedor[v] = vencidasPorVendedor[v] || []).push(t);
  }
  const vencidas = Object.entries(vencidasPorVendedor).map(([v, ts]) =>
    `<b>${escaparHtml(v)}</b> (${ts.length}): ${ts.map((t) => `${escaparHtml(t.tipo)} — ${escaparHtml(t.nombre || t.telefono)}`).join('; ')}`);

  const cotizadas = cotizaciones.map((n) => {
    const p = n.properties;
    const pedido = [p.producto, p.cantidad ? `x ${p.cantidad}` : null].filter(Boolean).join(' ');
    return `${escaparHtml(p.dealname)} — ${escaparHtml(nombreOwner(p.hubspot_owner_id))}${pedido ? ` — ${escaparHtml(pedido)}` : ''}`;
  });

  const perdidosTxt = perdidos.map((n) => {
    const p = n.properties;
    return `${escaparHtml(p.dealname)} — ${escaparHtml(nombreOwner(p.hubspot_owner_id))} — motivo: ${escaparHtml(p.motivo_perdida || 'sin motivo')}`;
  });

  const alertas = [];
  if (datos.analisis_con_error_24h) alertas.push(`${datos.analisis_con_error_24h} análisis de IA con error en las últimas 24 h (tabla analisis).`);
  if (datos.clientes_sin_analizar) alertas.push(`${datos.clientes_sin_analizar} cliente(s) sin analizar tras 5 fallos seguidos.`);

  const cuerpo = [
    `<p><b>Chats sin responder (${sinResponder.length})</b></p>${lista(sinResponder)}`,
    `<p><b>Tareas vencidas por vendedor</b></p>${lista(vencidas)}`,
    `<p><b>Cotizaciones abiertas (${cotizaciones.length})</b></p>${lista(cotizadas)}`,
    `<p><b>Negocios por etapa</b></p>${lista(porEtapa)}`,
    `<p><b>Perdidos en las últimas 24 h (${perdidos.length})</b></p>${lista(perdidosTxt)}`,
    alertas.length ? `<p><b>Alertas del sistema</b></p>${lista(alertas.map(escaparHtml))}` : '',
  ].join('');

  const p = partesLocales(new Date(ahora), tz);
  const asunto = `Resumen WhatsApp ${String(p.dia).padStart(2, '0')}/${String(p.mes).padStart(2, '0')}: `
    + `${sinResponder.length} sin responder, ${(datos.tareas_vencidas || []).length} tareas vencidas`;
  const tarea = await hs.crearTarea({
    asunto,
    cuerpo,
    vence: ahora,
    ownerId: config.hubspot.adminOwnerId,
    prioridad: 'MEDIUM',
  });
  return [{ asunto, hubspot_task_id: String(tarea.id) }];
}

module.exports = { resumir };
