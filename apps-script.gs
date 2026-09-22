// Sprint de Inteligencia Empresarial - Manejador de Inscripciones
// Google Apps Script v1.3

var NOTIFY_EMAIL = 'oscar@oscarb2b.com';
var SHEET_NAME   = 'Inscripciones SIE';

// ── Punto de entrada POST ────────────────────────────────
function doPost(e) {
  var p = e.parameter;

  // Honeypot anti-bot
  if (p.website && p.website.length > 0) {
    return respond('ok');
  }

  if (p.type === 'comprobante') {
    try { handleComprobante(p); } catch (err) { Logger.log('Comprobante error: ' + err); }
  } else if (p.type === 'registro_estudiante') {
    var ts2 = new Date();
    try { saveAccesoSheet(p, ts2); } catch (err) { Logger.log('Acceso error: ' + err); }
  } else if (p.type === 'registro_gratuito') {
    var ts3 = new Date();
    try { saveLeadsSheet(p, ts3); } catch (err) { Logger.log('Lead error: ' + err); }
  } else {
    var ts = new Date();
    // Cada operacion tiene su propio try-catch para que un fallo no bloquee las demas
    try { saveToSheet(p, ts); } catch (err) { Logger.log('Sheet error: ' + err); }
    try { sendNotificationEmail(p, ts); } catch (err) { Logger.log('Notify error: ' + err); }
    try { if (p.email) sendConfirmationEmail(p); } catch (err) { Logger.log('Confirm error: ' + err); }
  }

  return respond('ok');
}

// ── Funcion de prueba: ejecutar manualmente desde el editor ─
function testEmail() {
  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    subject: 'TEST - Correo SIE funcionando correctamente',
    body: 'Si recibes este correo, el sistema de correo del Apps Script esta funcionando.\n\nFecha: ' + new Date().toString()
  });
  Logger.log('Correo de prueba enviado a ' + NOTIFY_EMAIL);
}

// ── Guardar inscripción en Google Sheets ─────────────────
function saveToSheet(p, ts) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    var headers = [
      'Fecha/Hora (Caracas)', 'Nombre completo', 'Edad', 'Email',
      'Ciudad', 'WhatsApp', 'Talla', 'Semana elegida', 'Comentarios'
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
    p.talla       || '',
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
    + 'Talla:    ' + (p.talla    || '-') + '\n'
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

// ── Guardar leads de Recursos Gratis ────────────────────
function saveLeadsSheet(p, ts) {
  var ss        = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = 'Leads Gratis';
  var sheet     = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    var headers = ['Fecha/Hora (Caracas)', 'Nombre', 'Email'];
    sheet.appendRow(headers);
    var hr = sheet.getRange(1, 1, 1, headers.length);
    hr.setFontWeight('bold');
    hr.setBackground('#F59E0B');
    hr.setFontColor('#0a0a0a');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 175);
    sheet.setColumnWidth(2, 200);
    sheet.setColumnWidth(3, 220);
  }

  sheet.appendRow([
    Utilities.formatDate(ts, 'America/Caracas', 'dd/MM/yyyy HH:mm:ss'),
    p.nombre || '',
    p.email  || ''
  ]);
}

// ── Guardar acceso al portal de estudiantes ──────────────
function saveAccesoSheet(p, ts) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = 'Accesos Portal';
  var sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    var headers = ['Fecha/Hora (Caracas)', 'Email', 'Sección'];
    sheet.appendRow(headers);
    var hr = sheet.getRange(1, 1, 1, headers.length);
    hr.setFontWeight('bold');
    hr.setBackground('#009944');
    hr.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 175);
    sheet.setColumnWidth(2, 220);
  }

  sheet.appendRow([
    Utilities.formatDate(ts, 'America/Caracas', 'dd/MM/yyyy HH:mm:ss'),
    p.email   || '',
    p.seccion || ''
  ]);
}

function respond(status) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: status }))
    .setMimeType(ContentService.MimeType.JSON);
}
