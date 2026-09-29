'use strict';

// Títulos, fechas límite y reglas de las tareas de HubSpot.

const { sumarMinutosLaborables, instanteLocal } = require('./horario');
const { orden, esCerrada } = require('./etapas');

const TIPOS_TAREA = ['contestar', 'cotizar', 'seguimiento', 'verificar_pago', 'produccion', 'enviar', 'confirmar'];

// Tipos que Claude puede sugerir en tareas_nuevas.
const TIPOS_SUGERIBLES = ['contestar', 'cotizar', 'seguimiento', 'verificar_pago', 'enviar', 'confirmar'];

const PRIORIDAD = {
  contestar: 'HIGH',
  cotizar: 'HIGH',
  seguimiento: 'MEDIUM',
  verificar_pago: 'HIGH',
  produccion: 'MEDIUM',
  enviar: 'MEDIUM',
  confirmar: 'LOW',
};

function nombreCliente(cliente) {
  return (cliente.nombre_wa && cliente.nombre_wa.trim()) || cliente.telefono;
}

function tituloTarea(tipo, cliente, datos = {}) {
  const nombre = nombreCliente(cliente);
  switch (tipo) {
    case 'contestar':
      return `Contestar a ${nombre}`;
    case 'cotizar': {
      const pedido = [datos.producto, datos.cantidad != null && datos.cantidad !== '' ? `x ${datos.cantidad}` : null]
        .filter(Boolean)
        .join(' ');
      return pedido ? `Enviar cotización a ${nombre}: ${pedido}` : `Enviar cotización a ${nombre}`;
    }
    case 'seguimiento':
      return `Seguimiento de cotización a ${nombre}`;
    case 'verificar_pago':
      return `Verificar pago de ${nombre}`;
    case 'produccion':
      return `Iniciar producción del pedido de ${nombre}`;
    case 'enviar':
      return `Enviar pedido a ${nombre}`;
    case 'confirmar':
      return `Confirmar recepción con ${nombre}`;
    default:
      throw new Error(`Tipo de tarea desconocido: ${tipo}`);
  }
}

const HORA = 3600000;

// ctx: { ahora, config, cal (horario parseado o null), fechaEntrega ('AAAA-MM-DD'|null),
//        ultimoMsgEmpresaAt, inmediata (true = ya está vencida, p. ej. F3) }
function vencimiento(tipo, ctx) {
  const ahora = new Date(ctx.ahora).getTime();
  const { config } = ctx;
  switch (tipo) {
    case 'contestar':
      if (ctx.inmediata) return new Date(ahora);
      if (!ctx.cal) throw new Error('Se necesita HORARIO_LABORAL para la fecha límite de "contestar"');
      return sumarMinutosLaborables(ahora, config.slaNuevoMin, ctx.cal, config.timezone);
    case 'cotizar':
    case 'produccion':
      return new Date(ahora + 24 * HORA);
    case 'seguimiento': {
      // 48 h desde el envío de la cotización (último mensaje de la empresa).
      const envio = ctx.ultimoMsgEmpresaAt ? new Date(ctx.ultimoMsgEmpresaAt).getTime() : ahora;
      return new Date(Math.max(envio + config.slaSeguimientoHoras * HORA, ahora));
    }
    case 'verificar_pago':
      return new Date(ahora + 4 * HORA);
    case 'enviar': {
      // fecha_entrega − 1 día, a las 09:00 hora local; si no hay fecha, 24 h.
      if (ctx.fechaEntrega && /^\d{4}-\d{2}-\d{2}/.test(ctx.fechaEntrega)) {
        const [a, m, d] = ctx.fechaEntrega.slice(0, 10).split('-').map(Number);
        const limite = instanteLocal(a, m, d - 1, 9 * 60, config.timezone);
        return new Date(Math.max(limite, ahora));
      }
      return new Date(ahora + 24 * HORA);
    }
    case 'confirmar':
      return new Date(ahora + 48 * HORA);
    default:
      throw new Error(`Tipo de tarea desconocido: ${tipo}`);
  }
}

// ¿Tiene sentido una tarea de este tipo con el negocio en `etapa`?
// Evita, por ejemplo, "Enviar pedido" antes de que el pago esté verificado.
function tareaPermitida(tipo, etapa) {
  if (esCerrada(etapa)) return tipo === 'contestar' || tipo === 'seguimiento';
  const o = orden(etapa);
  switch (tipo) {
    case 'contestar':
    case 'seguimiento':
      return true;
    case 'cotizar':
      return o <= orden('cotizado');
    case 'verificar_pago':
      return o < orden('pagado');
    case 'produccion':
    case 'enviar':
      return o >= orden('pagado');
    case 'confirmar':
      return o >= orden('enviado');
    default:
      return false;
  }
}

module.exports = {
  TIPOS_TAREA,
  TIPOS_SUGERIBLES,
  PRIORIDAD,
  nombreCliente,
  tituloTarea,
  vencimiento,
  tareaPermitida,
};
