'use strict';

// WhatsApp entrega los números como dígitos sin "+" (wa_id, ej. "584141234567").
// En Postgres y HubSpot se guardan en E.164 ("+584141234567").

function soloDigitos(valor) {
  return String(valor || '').replace(/\D/g, '');
}

function aE164(valor) {
  const digitos = soloDigitos(valor);
  if (digitos.length < 8 || digitos.length > 15) {
    throw new Error(`Número de teléfono inválido: "${valor}"`);
  }
  return `+${digitos}`;
}

// Formatos con que el número puede estar guardado a mano en HubSpot.
function variantesBusqueda(e164) {
  const digitos = soloDigitos(e164);
  const variantes = new Set([`+${digitos}`, digitos]);
  if (digitos.startsWith('58') && digitos.length === 12) {
    const nacional = digitos.slice(2);                    // 4141234567
    variantes.add(`0${nacional}`);                        // 04141234567
    variantes.add(`0${nacional.slice(0, 3)}-${nacional.slice(3)}`); // 0414-1234567
    variantes.add(`+58 ${nacional.slice(0, 3)} ${nacional.slice(3)}`); // +58 414 1234567
  }
  return [...variantes];
}

module.exports = { soloDigitos, aE164, variantesBusqueda };
