'use strict';

// F5 — Resumen diario (cron 7:30 a. m., solo en días laborables).
//
//   Cron → [Postgres f5_datos] → resumir
//
// Crea tareas en HubSpot con el resumen en el cuerpo (llegan a la app móvil):
//   - a cada vendedor disponible, con sus propios pendientes: clientes esperando
//     respuesta, tareas vencidas, tareas de hoy y cotizaciones abiertas (si no
//     tiene nada pendiente, no se le manda nada);
//   - al administrador (ADMIN_HUBSPOT_OWNER_ID, opcional), el resumen general.

const { preparar, escaparHtml, lista } = require('./comun');
const { ETAPAS } = require('../etapas');
const { partesLocales, esDiaLaborable } = require('../horario');

const NOMBRE_TAREA = {
  contestar: 'Contestar',
  cotizar: 'Enviar cotización',
  seguimiento: 'Seguimiento de cotización',
  verificar_pago: 'Verificar pago',
  produccion: 'Iniciar producción',
  enviar: 'Enviar pedido',
  confirmar: 'Confirmar recepción',
};

const dos = (n) => String(n).padStart(2, '0');

function fechaCorta(fecha, tz) {
  const p = partesLocales(new Date(fecha), tz);
  return `${dos(p.dia)}/${dos(p.mes)} ${dos(p.hora)}:${dos(p.minuto)}`;
}

function horaCorta(fecha, tz) {
  const p = partesLocales(new Date(fecha), tz);
  return `${dos(p.hora)}:${dos(p.minuto)}`;
}

function diaLocal(fecha, tz) {
  const p = partesLocales(new Date(fecha), tz);
  return `${p.anio}-${dos(p.mes)}-${dos(p.dia)}`;
}

function horasDesde(fecha, ahora) {
  return Math.max(0, Math.round((new Date(ahora) - new Date(fecha)) / 3600000));
}

const cliente = (x) => escaparHtml(x.nombre || x.telefono);
const tipoTarea = (t) => escaparHtml(NOMBRE_TAREA[t.tipo] || t.tipo);

function pedido(p) {
  return [p.producto, p.cantidad ? `x ${p.cantidad}` : null].filter(Boolean).join(' ');
}

async function resumir(filas, ctx) {
  const { config, hs, cal, ahora } = preparar(ctx, ['hubspot']);
  const { pipelineId, etapas, adminOwnerId } = config.hubspot;
  const tz = config.timezone;
  if (cal && !esDiaLaborable(ahora, cal, tz)) return [{ omitido: 'día no laborable' }];

  const datos = (filas[0] && filas[0].datos) || {};
  const enPipeline = { propertyName: 'pipeline', operator: 'EQ', value: pipelineId };
  const hoy = diaLocal(ahora, tz);
  const fechaHoy = `${hoy.slice(8, 10)}/${hoy.slice(5, 7)}`;

  const cotizaciones = await hs.listarNegocios(
    [enPipeline, { propertyName: 'dealstage', operator: 'EQ', value: etapas.cotizado }],
    ['dealname', 'hubspot_owner_id', 'producto', 'cantidad', 'hs_lastmodifieddate'],
    100,
  );

  const creadas = [];

  // ── Resumen de cada vendedor ──
  for (const v of datos.vendedores || []) {
    const deVendedor = (x) => String(x.vendedor_owner_id) === String(v.hubspot_owner_id);
    const esperando = (datos.sin_responder || []).filter(deVendedor);
    const vencidas = (datos.tareas_vencidas || []).filter(deVendedor);
    const deHoy = (datos.tareas_abiertas || []).filter((t) => deVendedor(t)
      && new Date(t.vence_at) >= new Date(ahora) && diaLocal(t.vence_at, tz) === hoy);
    const cotizadas = cotizaciones.filter((n) => String(n.properties.hubspot_owner_id) === String(v.hubspot_owner_id));
    if (!esperando.length && !vencidas.length && !deHoy.length && !cotizadas.length) continue;

    const cuerpo = [
      `<p>Buenos días, ${escaparHtml(v.nombre)}. Esto es lo tuyo para hoy:</p>`,
      `<p><b>Clientes esperando tu respuesta (${esperando.length})</b></p>`
        + lista(esperando.map((c) => `${cliente(c)} — desde ${fechaCorta(c.desde, tz)} (${horasDesde(c.desde, ahora)} h)`)),
      `<p><b>Tareas vencidas (${vencidas.length})</b></p>`
        + lista(vencidas.map((t) => `${tipoTarea(t)} — ${cliente(t)} (venció ${fechaCorta(t.vence_at, tz)})`)),
      `<p><b>Tareas para hoy (${deHoy.length})</b></p>`
        + lista(deHoy.map((t) => `${tipoTarea(t)} — ${cliente(t)} (a las ${horaCorta(t.vence_at, tz)})`)),
      `<p><b>Tus cotizaciones abiertas (${cotizadas.length})</b></p>`
        + lista(cotizadas.map((n) => {
          const detalle = pedido(n.properties);
          return `${escaparHtml(n.properties.dealname)}${detalle ? ` — ${escaparHtml(detalle)}` : ''}`;
        })),
    ].join('');
    const asunto = `Tus pendientes ${fechaHoy}: ${esperando.length} por responder, `
      + `${vencidas.length} vencidas, ${deHoy.length} para hoy`;
    const tarea = await hs.crearTarea({
      asunto,
      cuerpo,
      vence: ahora,
      ownerId: v.hubspot_owner_id,
      prioridad: esperando.length || vencidas.length ? 'HIGH' : 'MEDIUM',
    });
    creadas.push({ para: v.nombre, asunto, hubspot_task_id: String(tarea.id) });
  }

  // ── Resumen general para el administrador ──
  if (adminOwnerId) {
    // Nombres de los propietarios (si la llave no tiene el permiso de owners, se muestran los IDs).
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

    // Perdidos en las últimas 24 h (negocios en Perdido modificados en ese lapso).
    const desde = new Date(ahora).getTime() - 24 * 3600000;
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
      `${cliente(c)} (${escaparHtml(c.vendedor || 'sin vendedor')}) — esperando desde ${fechaCorta(c.desde, tz)}, ${horasDesde(c.desde, ahora)} h`);

    const vencidasPorVendedor = {};
    for (const t of datos.tareas_vencidas || []) {
      const v = t.vendedor || 'sin vendedor';
      (vencidasPorVendedor[v] = vencidasPorVendedor[v] || []).push(t);
    }
    const vencidas = Object.entries(vencidasPorVendedor).map(([v, ts]) =>
      `<b>${escaparHtml(v)}</b> (${ts.length}): ${ts.map((t) => `${escaparHtml(t.tipo)} — ${cliente(t)}`).join('; ')}`);

    const cotizadas = cotizaciones.map((n) => {
      const p = n.properties;
      const detalle = pedido(p);
      return `${escaparHtml(p.dealname)} — ${escaparHtml(nombreOwner(p.hubspot_owner_id))}${detalle ? ` — ${escaparHtml(detalle)}` : ''}`;
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

    const asunto = `Resumen WhatsApp ${fechaHoy}: `
      + `${sinResponder.length} sin responder, ${(datos.tareas_vencidas || []).length} tareas vencidas`;
    const tarea = await hs.crearTarea({ asunto, cuerpo, vence: ahora, ownerId: adminOwnerId, prioridad: 'MEDIUM' });
    creadas.push({ para: 'administrador', asunto, hubspot_task_id: String(tarea.id) });
  }

  return creadas.length ? creadas : [{ omitido: 'nadie tiene pendientes' }];
}

module.exports = { resumir };
