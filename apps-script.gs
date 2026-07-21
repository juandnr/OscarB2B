// Sprint de Inteligencia Empresarial - Manejador de Inscripciones
// Google Apps Script v1.1

var NOTIFY_EMAIL = 'oscar@oscarb2b.com';
var SHEET_NAME   = 'Inscripciones SIE';

function doPost(e) {
  try {
    var p = e.parameter;

    // Honeypot: si el campo oculto "website" tiene valor, es un bot
    if (p.website && p.website.length > 0) {
      return respond('ok');
    }

    var ts = new Date();
    saveToSheet(p, ts);
    sendNotificationEmail(p, ts);
    if (p.email) sendConfirmationEmail(p);
    return respond('ok');

  } catch (err) {
    Logger.log('SIE Form Error: ' + err.toString());
    return respond('error');
  }
}

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
    p.nombre   || '',
    p.edad     || '',
    p.email    || '',
    p.ciudad   || '',
    p.whatsapp || '',
    p.semana   || '',
    p.comentarios || ''
  ]);
}

function sendNotificationEmail(p, ts) {
  var fecha  = Utilities.formatDate(ts, 'America/Caracas', 'dd/MM/yyyy HH:mm:ss');
  var nombre = p.nombre || 'Sin nombre';
  var semana = p.semana || 'No especificada';

  var subject = 'Nueva inscripcion SIE - ' + nombre + ' - ' + semana;

  var body = '==========================================\n'
    + 'NUEVA INSCRIPCION - Sprint de Inteligencia Empresarial\n'
    + '==========================================\n\n'
    + 'Recibida el: ' + fecha + ' (hora Caracas)\n\n'
    + '--- DATOS DEL POSTULANTE ---\n'
    + 'Nombre:   ' + (p.nombre   || '-') + '\n'
    + 'Edad:     ' + (p.edad     || '-') + '\n'
    + 'Email:    ' + (p.email    || '-') + '\n'
    + 'WhatsApp: ' + (p.whatsapp || '-') + '\n'
    + 'Ciudad:   ' + (p.ciudad   || '-') + '\n'
    + 'Semana:   ' + (p.semana   || '-') + '\n\n'
    + 'Comentarios:\n'
    + (p.comentarios || '-') + '\n\n'
    + '==========================================\n'
    + 'Enviado via oscarb2b.com/sprint.html\n'
    + '==========================================';

  MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: subject, body: body });
}

function sendConfirmationEmail(p) {
  var nombre = p.nombre || 'Participante';
  var semana = p.semana || 'la semana seleccionada';

  var subject = 'Tu inscripcion al Sprint SIE esta reservada - ' + nombre;

  var body = 'Hola ' + nombre + ',\n\n'
    + 'Recibimos tu inscripcion al Sprint de Inteligencia Empresarial.\n'
    + 'Tu semana seleccionada es: ' + semana + '\n\n'
    + 'Para confirmar tu lugar, realiza el pago de $500 USD por cualquiera\n'
    + 'de los siguientes metodos y envianos el comprobante:\n\n'
    + '  Zelle:       oscarpaez17@gmail.com (Titular: Oscar Paez)\n'
    + '  PayPal:      diddybay@gmail.com\n'
    + '  Binance Pay: ID 114021502 (USDT)\n'
    + '  Pago Movil:  04241640002 - Banesco - CI V-20652480\n\n'
    + 'Envia el comprobante por WhatsApp o respondiendo este correo.\n\n'
    + 'Si tienes alguna pregunta no dudes en escribirnos.\n\n'
    + '-- Equipo Oscar B2B\n'
    + 'oscarb2b.com';

  MailApp.sendEmail({ to: p.email, subject: subject, body: body });
}

function respond(status) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: status }))
    .setMimeType(ContentService.MimeType.JSON);
}
