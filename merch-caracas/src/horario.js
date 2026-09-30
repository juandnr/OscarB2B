'use strict';

// Cálculos en horario laboral.
//
// HORARIO_LABORAL tiene la forma:
//   "lun-vie 08:00-17:00; sab 08:00-12:00"
//   "lun-vie 08:00-12:00,13:00-17:00"      (varios tramos en el día)
//   "lun,mie,vie 09:00-13:00"
// FERIADOS: fechas locales sin horario laboral, "2026-12-24,2026-12-25".

const DIAS = { dom: 0, lun: 1, mar: 2, mie: 3, jue: 4, vie: 5, sab: 6 };

function normalizarDia(texto) {
  return texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').slice(0, 3);
}

function minutosDeHora(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`Hora inválida en HORARIO_LABORAL: "${hhmm}"`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) throw new Error(`Hora inválida en HORARIO_LABORAL: "${hhmm}"`);
  return h * 60 + min;
}

function expandirDias(texto) {
  const dias = new Set();
  for (const parte of texto.split(',')) {
    const [desde, hasta] = parte.split('-').map((d) => normalizarDia(d.trim()));
    if (!(desde in DIAS) || (hasta !== undefined && !(hasta in DIAS))) {
      throw new Error(`Día inválido en HORARIO_LABORAL: "${parte}"`);
    }
    if (hasta === undefined) {
      dias.add(DIAS[desde]);
    } else {
      for (let d = DIAS[desde]; ; d = (d + 1) % 7) {
        dias.add(d);
        if (d === DIAS[hasta]) break;
      }
    }
  }
  return [...dias];
}

// Devuelve { semana: {0..6: [[inicioMin, finMin], ...]}, feriados: Set('AAAA-MM-DD') }
function parsearHorario(horarioTexto, feriadosTexto = '') {
  if (!horarioTexto || !horarioTexto.trim()) {
    throw new Error('HORARIO_LABORAL no está definido');
  }
  const semana = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const bloque of horarioTexto.split(';').map((b) => b.trim()).filter(Boolean)) {
    const m = /^(\S+)\s+(.+)$/.exec(bloque);
    if (!m) throw new Error(`Bloque inválido en HORARIO_LABORAL: "${bloque}"`);
    const dias = expandirDias(m[1]);
    for (const tramo of m[2].split(',')) {
      const [inicio, fin] = tramo.split('-').map(minutosDeHora);
      if (!(inicio < fin)) throw new Error(`Tramo inválido en HORARIO_LABORAL: "${tramo}"`);
      for (const d of dias) semana[d].push([inicio, fin]);
    }
  }
  for (const d of Object.keys(semana)) {
    semana[d].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < semana[d].length; i++) {
      if (semana[d][i][0] < semana[d][i - 1][1]) throw new Error('Tramos solapados en HORARIO_LABORAL');
    }
  }
  const feriados = new Set(
    String(feriadosTexto || '').split(',').map((f) => f.trim()).filter(Boolean),
  );
  for (const f of feriados) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) throw new Error(`Fecha inválida en FERIADOS: "${f}"`);
  }
  return { semana, feriados };
}

const formateadores = {};

function partesLocales(fecha, tz) {
  if (!formateadores[tz]) {
    formateadores[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
  }
  const p = {};
  for (const { type, value } of formateadores[tz].formatToParts(fecha)) p[type] = value;
  const semana = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    anio: Number(p.year), mes: Number(p.month), dia: Number(p.day),
    hora: Number(p.hour), minuto: Number(p.minute), segundo: Number(p.second),
    diaSemana: semana[p.weekday],
  };
}

function desfaseMin(instante, tz) {
  const p = partesLocales(new Date(instante), tz);
  const comoUtc = Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return Math.round((comoUtc - Math.floor(instante / 1000) * 1000) / 60000);
}

// Instante UTC de una hora local (minutos desde medianoche) en la zona `tz`.
function instanteLocal(anio, mes, dia, minutos, tz) {
  const ingenuo = Date.UTC(anio, mes - 1, dia, 0, minutos);
  let resultado = ingenuo - desfaseMin(ingenuo, tz) * 60000;
  const corregido = ingenuo - desfaseMin(resultado, tz) * 60000;
  if (corregido !== resultado) resultado = corregido;
  return resultado;
}

function fechaLocalTexto(anio, mes, dia) {
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// Recorre los tramos laborales (en ms UTC) desde el día local de `desde`.
function* tramos(desde, cal, tz, maxDias = 400) {
  const p = partesLocales(new Date(desde), tz);
  for (let i = 0; i < maxDias; i++) {
    const f = new Date(Date.UTC(p.anio, p.mes - 1, p.dia + i));
    const anio = f.getUTCFullYear();
    const mes = f.getUTCMonth() + 1;
    const dia = f.getUTCDate();
    if (cal.feriados.has(fechaLocalTexto(anio, mes, dia))) continue;
    for (const [ini, fin] of cal.semana[f.getUTCDay()]) {
      yield [instanteLocal(anio, mes, dia, ini, tz), instanteLocal(anio, mes, dia, fin, tz)];
    }
  }
}

// Suma `minutos` laborables a `desde`. Si `desde` cae fuera de horario, el
// conteo empieza en la siguiente apertura.
function sumarMinutosLaborables(desde, minutos, cal, tz) {
  const inicio = new Date(desde).getTime();
  let restante = minutos * 60000;
  for (const [a, b] of tramos(inicio, cal, tz)) {
    if (b <= inicio) continue;
    const desdeTramo = Math.max(a, inicio);
    const disponible = b - desdeTramo;
    if (restante <= disponible) return new Date(desdeTramo + restante);
    restante -= disponible;
  }
  throw new Error('HORARIO_LABORAL no tiene horas laborables en el próximo año');
}

// Minutos laborables entre dos instantes (0 si hasta <= desde).
function minutosLaborablesEntre(desde, hasta, cal, tz) {
  const a0 = new Date(desde).getTime();
  const b0 = new Date(hasta).getTime();
  if (b0 <= a0) return 0;
  let total = 0;
  for (const [a, b] of tramos(a0, cal, tz)) {
    if (a >= b0) break;
    if (b <= a0) continue;
    total += Math.min(b, b0) - Math.max(a, a0);
  }
  return total / 60000;
}

function enHorarioLaboral(fecha, cal, tz) {
  const t = new Date(fecha).getTime();
  for (const [a, b] of tramos(t, cal, tz, 1)) {
    if (t >= a && t < b) return true;
  }
  return false;
}

// ¿El día local de `fecha` tiene horas laborables (y no es feriado)?
function esDiaLaborable(fecha, cal, tz) {
  const p = partesLocales(new Date(fecha), tz);
  const texto = `${p.anio}-${String(p.mes).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}`;
  return cal.semana[p.diaSemana].length > 0 && !cal.feriados.has(texto);
}

module.exports = {
  esDiaLaborable,
  parsearHorario,
  partesLocales,
  instanteLocal,
  sumarMinutosLaborables,
  minutosLaborablesEntre,
  enHorarioLaboral,
};
