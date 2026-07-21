// Sprint de Inteligencia Empresarial - Manejador de Inscripciones
// Google Apps Script v1.2

var NOTIFY_EMAIL = 'oscar@oscarb2b.com';
var SHEET_NAME   = 'Inscripciones SIE';

// ── Punto de entrada POST ────────────────────────────────
function doPost(e) {
  try {
    var p = e.parameter;

    // Honeypot anti-bot
    if (p.website && p.website.length > 0) {
      return respond('ok');
    }

    if (p.type === 'comprobante') {
      handleComprobante(p);
    } else {
      var ts = new Date();
      saveToSheet(p, ts);
      sendNotificationEmail(p, ts);
      if (p.email) sendConfirmationEmail(p);
    }

    return respond('ok');

  } catch (err) {
    Logger.log('SIE Error: ' + err.toString());
    return respond('error');
  }
}

// ── Guardar inscripción en Google Sheets ─────────────────
function saveToSheet(p, ts) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    var headers = [
      'Fecha/Hora (Caracas)', 'Nombre completo', 'Edad', 'Email',
      'Ciudad', 'WhatsApp', 'Semana elegida', 'Comentarios'
    ];
    sheet.appendRow(headers);
    var hr = sheet.getRange(1, 1, 1, headers.length);
    hr.setFontWeight('bold');
    hr.setBackground('#F5A623');
    hr.setFontColor('#0a0a0a');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 175);
  }

  sheet.appendRow([
    Utilities.formatDate(ts, 'America/Caracas', 'dd/MM/yyyy HH:mm:ss'),
    p.nombre      || '',
    p.edad        || '',
    p.email       || '',
    p.ciudad      || '',
    p.whatsapp    || '',
    p.semana      || '',
    p.comentarios || ''
  ]);
}

// ── Manejar comprobante de pago ──────────────────────────
function handleComprobante(p) {
  var nombre   = p.nombre   || 'Participante';
  var email    = p.email    || '';
  var whatsapp = p.whatsapp || '-';
  var semana   = p.semana   || '-';

  var subject = 'Comprobante recibido - ' + nombre + ' - ' + semana;
  var body = 'Se recibio un comprobante de pago del Sprint SIE.\n\n'
    + 'Nombre:   ' + nombre   + '\n'
    + 'Email:    ' + email    + '\n'
    + 'WhatsApp: ' + whatsapp + '\n'
    + 'Semana:   ' + semana   + '\n\n'
    + 'El comprobante llega adjunto a este correo.\n'
    + 'Confirma el pago y escribe al participante.';

  var options = { to: NOTIFY_EMAIL, subject: subject, body: body };

  // Adjuntar el archivo al correo
  if (p.fileData && p.fileName) {
    var blob = Utilities.newBlob(
      Utilities.base64Decode(p.fileData),
      p.mimeType || 'application/octet-stream',
      nombre + ' - ' + semana + ' - ' + p.fileName
    );
    options.attachments = [blob];
  }

  MailApp.sendEmail(options);

  // Confirmar al usuario que recibimos el comprobante
  if (email) {
    var userSubject = 'Recibimos tu comprobante SIE - ' + nombre;
    var userBody = 'Hola ' + nombre + ',\n\n'
      + 'Recibimos tu comprobante de pago para el Sprint de Inteligencia Empresarial.\n'
      + 'Lo estamos revisando y en breve te confirmaremos que tu lugar quedo reservado.\n\n'
      + 'Si tienes alguna pregunta puedes responder este correo.\n\n'
      + '-- Equipo Oscar B2B\n'
      + 'oscarb2b.com';
    MailApp.sendEmail({ to: email, subject: userSubject, body: userBody });
  }
}

// ── Correo de notificación de nueva inscripción ──────────
function sendNotificationEmail(p, ts) {
  var fecha  = Utilities.formatDate(ts, 'America/Caracas', 'dd/MM/yyyy HH:mm:ss');
  var nombre = p.nombre || 'Sin nombre';
  var semana = p.semana || 'No especificada';

  var subject = 'Nueva inscripcion SIE - ' + nombre + ' - ' + semana;

  var body = '==========================================\n'
    + 'NUEVA INSCRIPCION - Sprint de Inteligencia Empresarial\n'
    + '==========================================\n\n'
    + 'Recibida el: ' + fecha + ' (hora Caracas)\n\n'
    + 'Nombre:   ' + (p.nombre   || '-') + '\n'
    + 'Edad:     ' + (p.edad     || '-') + '\n'
    + 'Email:    ' + (p.email    || '-') + '\n'
    + 'WhatsApp: ' + (p.whatsapp || '-') + '\n'
    + 'Ciudad:   ' + (p.ciudad   || '-') + '\n'
    + 'Semana:   ' + (p.semana   || '-') + '\n\n'
    + 'Comentarios: ' + (p.comentarios || '-');

  MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: subject, body: body });
}

// ── Correo de confirmación de reserva al usuario ─────────
function sendConfirmationEmail(p) {
  var nombre = p.nombre || 'Participante';
  var semana = p.semana || 'la semana seleccionada';

  var subject = 'Tu inscripcion al Sprint SIE esta reservada - ' + nombre;

  var body = 'Hola ' + nombre + ',\n\n'
    + 'Recibimos tu inscripcion al Sprint de Inteligencia Empresarial.\n'
    + 'Tu semana seleccionada es: ' + semana + '\n\n'
    + 'Para confirmar tu lugar, realiza el pago de $500 USD:\n\n'
    + '  Zelle:       oscarpaez17@gmail.com (Titular: Oscar Paez)\n'
    + '  PayPal:      diddybay@gmail.com\n'
    + '  Binance Pay: ID 114021502 (USDT)\n'
    + '  Pago Movil:  04241640002 - Banesco - CI V-20652480\n\n'
    + 'Una vez pagado, sube tu comprobante directamente en la pagina.\n\n'
    + '-- Equipo Oscar B2B\n'
    + 'oscarb2b.com';

  MailApp.sendEmail({ to: p.email, subject: subject, body: body });
}

function respond(status) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: status }))
    .setMimeType(ContentService.MimeType.JSON);
}
