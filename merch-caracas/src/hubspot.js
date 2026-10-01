'use strict';

// Cliente mínimo de la API de HubSpot (CRM v3) sobre una función http inyectada:
//   http({ method, url, headers, body }) → Promise<{ status, body, headers }>
// En n8n se implementa con helpers.httpRequest; en los scripts, con fetch.

const { variantesBusqueda } = require('./telefono');

// Tipos de asociación definidos por HubSpot.
const ASOC = {
  negocioContacto: 3,
  tareaContacto: 204,
  tareaNegocio: 216,
  notaContacto: 202,
  notaNegocio: 214,
};

const PROPIEDADES_NEGOCIO = [
  'dealname', 'dealstage', 'pipeline', 'hubspot_owner_id', 'wa_telefono', 'producto',
  'cantidad', 'fecha_entrega', 'empresa_cliente', 'resumen_ia', 'motivo_perdida',
];

class HubSpotError extends Error {
  constructor(metodo, ruta, status, cuerpo) {
    const detalle = cuerpo && (cuerpo.message || JSON.stringify(cuerpo));
    super(`HubSpot ${metodo} ${ruta} → ${status}: ${detalle}`);
    this.status = status;
    this.cuerpo = cuerpo;
  }
}

function asociacion(id, tipo) {
  return { to: { id: String(id) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: tipo }] };
}

function trozos(lista, tamano) {
  const salida = [];
  for (let i = 0; i < lista.length; i += tamano) salida.push(lista.slice(i, i + tamano));
  return salida;
}

function crearHubSpot({ http, token, apiUrl = 'https://api.hubapi.com', esperar }) {
  if (!token) throw new Error('Falta HUBSPOT_PRIVATE_APP_TOKEN');
  const pausa = esperar || ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function solicitud(method, ruta, body, { aceptar = [] } = {}) {
    let intento = 0;
    for (;;) {
      intento += 1;
      let respuesta;
      try {
        respuesta = await http({
          method,
          url: `${apiUrl}${ruta}`,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body,
        });
      } catch (error) {
        if (intento < 3) {
          await pausa(1000 * intento);
          continue;
        }
        throw error;
      }
      const { status } = respuesta;
      if ((status >= 200 && status < 300) || aceptar.includes(status)) return respuesta;
      if ((status === 429 || status >= 500) && intento < 4) {
        const reintentar = Number(respuesta.headers && respuesta.headers['retry-after']);
        await pausa(Number.isFinite(reintentar) && reintentar > 0 ? reintentar * 1000 : 1500 * intento);
        continue;
      }
      throw new HubSpotError(method, ruta, status, respuesta.body);
    }
  }

  const api = {
    solicitud,

    // ── Búsquedas ──
    async buscar(objeto, cuerpo) {
      const r = await solicitud('POST', `/crm/v3/objects/${objeto}/search`, cuerpo);
      return r.body;
    },

    // Negocios del pipeline con wa_telefono = e164, el más reciente primero.
    async buscarNegociosPorTelefono(e164, pipelineId) {
      const r = await api.buscar('deals', {
        filterGroups: [{
          filters: [
            { propertyName: 'wa_telefono', operator: 'EQ', value: e164 },
            { propertyName: 'pipeline', operator: 'EQ', value: pipelineId },
          ],
        }],
        properties: PROPIEDADES_NEGOCIO,
        sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
        limit: 10,
      });
      return r.results || [];
    },

    async buscarContactoPorTelefono(e164) {
      const variantes = variantesBusqueda(e164);
      const r = await api.buscar('contacts', {
        filterGroups: [
          { filters: [{ propertyName: 'phone', operator: 'IN', values: variantes }] },
          { filters: [{ propertyName: 'mobilephone', operator: 'IN', values: variantes }] },
        ],
        properties: ['firstname', 'lastname', 'phone', 'mobilephone', 'hubspot_owner_id'],
        sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
        limit: 10,
      });
      return (r.results || [])[0] || null;
    },

    async buscarContactoPorEmail(email) {
      const r = await api.buscar('contacts', {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: String(email).toLowerCase() }] }],
        properties: ['firstname', 'lastname', 'email', 'hubspot_owner_id'],
        sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
        limit: 10,
      });
      return (r.results || [])[0] || null;
    },

    async negociosDeContacto(contactId, pipelineId) {
      const r = await api.buscar('deals', {
        filterGroups: [{
          filters: [
            { propertyName: 'associations.contact', operator: 'EQ', value: String(contactId) },
            { propertyName: 'pipeline', operator: 'EQ', value: pipelineId },
          ],
        }],
        properties: PROPIEDADES_NEGOCIO,
        sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
        limit: 10,
      });
      return r.results || [];
    },

    async contarNegocios(filtros) {
      const r = await api.buscar('deals', { filterGroups: [{ filters: filtros }], properties: ['dealname'], limit: 1 });
      return r.total || 0;
    },

    async listarNegocios(filtros, propiedades = PROPIEDADES_NEGOCIO, maximo = 200) {
      const resultados = [];
      let after;
      do {
        const r = await api.buscar('deals', {
          filterGroups: [{ filters: filtros }],
          properties: propiedades,
          sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
          limit: 100,
          ...(after ? { after } : {}),
        });
        resultados.push(...(r.results || []));
        after = r.paging && r.paging.next && r.paging.next.after;
      } while (after && resultados.length < maximo);
      return resultados.slice(0, maximo);
    },

    // ── Contactos ──
    async crearContacto(propiedades) {
      const r = await solicitud('POST', '/crm/v3/objects/contacts', { properties: propiedades });
      return r.body;
    },

    async actualizarContacto(id, propiedades) {
      const r = await solicitud('PATCH', `/crm/v3/objects/contacts/${id}`, { properties: propiedades });
      return r.body;
    },

    // ── Negocios ──
    async crearNegocio(propiedades, contactId) {
      const r = await solicitud('POST', '/crm/v3/objects/deals', {
        properties: propiedades,
        associations: contactId ? [asociacion(contactId, ASOC.negocioContacto)] : [],
      });
      return r.body;
    },

    // null si el negocio no existe (borrado).
    async leerNegocio(id, propiedades = PROPIEDADES_NEGOCIO) {
      const r = await solicitud(
        'GET',
        `/crm/v3/objects/deals/${id}?properties=${propiedades.join(',')}`,
        undefined,
        { aceptar: [404] },
      );
      return r.status === 404 ? null : r.body;
    },

    // Devuelve { [id]: negocio }; los que no existen no aparecen.
    async leerNegocios(ids, propiedades = PROPIEDADES_NEGOCIO) {
      return api.leerLote('deals', ids, propiedades);
    },

    async actualizarNegocio(id, propiedades) {
      const r = await solicitud('PATCH', `/crm/v3/objects/deals/${id}`, { properties: propiedades });
      return r.body;
    },

    // ── Tareas ──
    // tarea: { asunto, cuerpo, vence (Date), ownerId, dealId, contactId, prioridad }
    async crearTarea(tarea) {
      const associations = [];
      if (tarea.dealId) associations.push(asociacion(tarea.dealId, ASOC.tareaNegocio));
      if (tarea.contactId) associations.push(asociacion(tarea.contactId, ASOC.tareaContacto));
      const properties = {
        hs_task_subject: tarea.asunto,
        hs_task_body: tarea.cuerpo || '',
        hs_task_status: 'NOT_STARTED',
        hs_task_priority: tarea.prioridad || 'MEDIUM',
        hs_task_type: 'TODO',
        hs_timestamp: new Date(tarea.vence).toISOString(),
      };
      if (tarea.ownerId) properties.hubspot_owner_id = String(tarea.ownerId);
      const r = await solicitud('POST', '/crm/v3/objects/tasks', { properties, associations });
      return r.body;
    },

    async leerTareas(ids) {
      return api.leerLote('tasks', ids, ['hs_task_status', 'hs_task_subject', 'hs_task_completion_date', 'hs_timestamp', 'hubspot_owner_id']);
    },

    // null si la tarea no existe (borrada).
    async actualizarTarea(id, propiedades) {
      const r = await solicitud('PATCH', `/crm/v3/objects/tasks/${id}`, { properties: propiedades }, { aceptar: [404] });
      return r.status === 404 ? null : r.body;
    },

    async completarTarea(id) {
      const r = await solicitud(
        'PATCH',
        `/crm/v3/objects/tasks/${id}`,
        { properties: { hs_task_status: 'COMPLETED' } },
        { aceptar: [404] },
      );
      return r.status === 404 ? null : r.body;
    },

    // ── Notas ──
    async crearNota({ cuerpo, dealId, contactId, ownerId }) {
      const associations = [];
      if (dealId) associations.push(asociacion(dealId, ASOC.notaNegocio));
      if (contactId) associations.push(asociacion(contactId, ASOC.notaContacto));
      const properties = { hs_note_body: cuerpo, hs_timestamp: new Date().toISOString() };
      if (ownerId) properties.hubspot_owner_id = String(ownerId);
      const r = await solicitud('POST', '/crm/v3/objects/notes', { properties, associations });
      return r.body;
    },

    // ── Lectura por lotes (100 por solicitud) ──
    async leerLote(objeto, ids, propiedades) {
      const salida = {};
      const unicos = [...new Set(ids.filter(Boolean).map(String))];
      for (const grupo of trozos(unicos, 100)) {
        const r = await solicitud(
          'POST',
          `/crm/v3/objects/${objeto}/batch/read`,
          { properties: propiedades, inputs: grupo.map((id) => ({ id })) },
          { aceptar: [207, 404] },
        );
        for (const obj of (r.body && r.body.results) || []) salida[String(obj.id)] = obj;
      }
      return salida;
    },

    // ── Propietarios ──
    async listarPropietarios() {
      const salida = [];
      let after;
      do {
        const r = await solicitud('GET', `/crm/v3/owners?limit=100${after ? `&after=${after}` : ''}`);
        salida.push(...(r.body.results || []));
        after = r.body.paging && r.body.paging.next && r.body.paging.next.after;
      } while (after);
      return salida;
    },
  };
  return api;
}

module.exports = { crearHubSpot, HubSpotError, ASOC, PROPIEDADES_NEGOCIO };
