'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parsearHorario, sumarMinutosLaborables, minutosLaborablesEntre, enHorarioLaboral, instanteLocal,
} = require('../src/horario');

const TZ = 'America/Caracas'; // UTC-4 todo el año
const cal = parsearHorario('lun-vie 08:00-12:00,13:00-17:00; sab 08:00-12:00', '2026-10-12');
// 2026-09-29 es martes. 12:00Z = 08:00 en Caracas.
const iso = (s) => new Date(s).toISOString();

test('parsea días, rangos y tramos', () => {
  assert.deepEqual(cal.semana[1], [[480, 720], [780, 1020]]);
  assert.deepEqual(cal.semana[6], [[480, 720]]);
  assert.deepEqual(cal.semana[0], []);
  assert.ok(cal.feriados.has('2026-10-12'));
  const acentos = parsearHorario('Mié,Sáb 09:00-10:00');
  assert.deepEqual(acentos.semana[3], [[540, 600]]);
  assert.deepEqual(acentos.semana[6], [[540, 600]]);
  const vuelta = parsearHorario('vie-lun 10:00-11:00');
  assert.deepEqual([0, 1, 5, 6].map((d) => vuelta.semana[d].length), [1, 1, 1, 1]);
});

test('errores de formato', () => {
  assert.throws(() => parsearHorario(''), /no está definido/);
  assert.throws(() => parsearHorario('lunes-viernes 8-17'), /inválid/);
  assert.throws(() => parsearHorario('lun 17:00-08:00'), /Tramo inválido/);
  assert.throws(() => parsearHorario('lun 08:00-12:00,11:00-13:00'), /solapados/);
  assert.throws(() => parsearHorario('lun 08:00-12:00', '29/09/2026'), /FERIADOS/);
});

test('instanteLocal convierte hora de Caracas a UTC', () => {
  assert.equal(new Date(instanteLocal(2026, 9, 29, 8 * 60, TZ)).toISOString(), '2026-09-29T12:00:00.000Z');
});

test('suma dentro del mismo tramo', () => {
  assert.equal(iso(sumarMinutosLaborables('2026-09-29T14:00:00Z', 15, cal, TZ)), '2026-09-29T14:15:00.000Z');
});

test('salta el almuerzo', () => {
  // 11:50 + 15 min → 13:05 hora local
  assert.equal(iso(sumarMinutosLaborables('2026-09-29T15:50:00Z', 15, cal, TZ)), '2026-09-29T17:05:00.000Z');
});

test('fuera de horario empieza en la próxima apertura', () => {
  // martes 20:00 local → miércoles 08:15
  assert.equal(iso(sumarMinutosLaborables('2026-09-30T00:00:00Z', 15, cal, TZ)), '2026-09-30T12:15:00.000Z');
  // sábado 11:55 → pasa el domingo → lunes 08:10
  assert.equal(iso(sumarMinutosLaborables('2026-10-03T15:55:00Z', 15, cal, TZ)), '2026-10-05T12:10:00.000Z');
});

test('respeta feriados', () => {
  // domingo 11/10 20:00 → el lunes 12/10 es feriado → martes 13/10 08:15
  assert.equal(iso(sumarMinutosLaborables('2026-10-12T00:00:00Z', 15, cal, TZ)), '2026-10-13T12:15:00.000Z');
});

test('minutos laborables entre dos instantes', () => {
  assert.equal(minutosLaborablesEntre('2026-09-29T12:00:00Z', '2026-09-29T12:45:00Z', cal, TZ), 45);
  // viernes 16:30 → lunes 08:30 = 30 + 240 (sábado) + 30
  assert.equal(minutosLaborablesEntre('2026-10-02T20:30:00Z', '2026-10-05T12:30:00Z', cal, TZ), 300);
  assert.equal(minutosLaborablesEntre('2026-09-29T13:00:00Z', '2026-09-29T12:00:00Z', cal, TZ), 0);
  // de noche no corre el reloj
  assert.equal(minutosLaborablesEntre('2026-09-29T23:00:00Z', '2026-09-30T02:00:00Z', cal, TZ), 0);
});

test('en horario laboral', () => {
  assert.equal(enHorarioLaboral('2026-09-29T12:00:00Z', cal, TZ), true);
  assert.equal(enHorarioLaboral('2026-09-29T16:30:00Z', cal, TZ), false); // almuerzo
  assert.equal(enHorarioLaboral('2026-09-29T21:00:00Z', cal, TZ), false); // 17:00 cierra
  assert.equal(enHorarioLaboral('2026-10-04T14:00:00Z', cal, TZ), false); // domingo
  assert.equal(enHorarioLaboral('2026-10-12T14:00:00Z', cal, TZ), false); // feriado
});

test('zona con horario de verano', () => {
  const ny = parsearHorario('lun-dom 09:00-10:00');
  // 2026-03-08 cambia a horario de verano en Nueva York (UTC-5 → UTC-4)
  assert.equal(iso(sumarMinutosLaborables('2026-03-07T15:00:00Z', 30, ny, 'America/New_York')), '2026-03-08T13:30:00.000Z');
});
