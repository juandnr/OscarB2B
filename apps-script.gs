// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Sprint de Inteligencia Empresarial — Manejador de Inscripciones
//  Google Apps Script · v1.0
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const NOTIFY_EMAIL = 'oscar@oscarb2b.com'; // Cambia si necesitas otro destinatario
const SHEET_NAME   = 'Inscripciones SIE';

// ── Punto de entrada POST ────────────────────────────────
function doPost(e) {
  try {
    var p = e.parameter;

    // Honeypot: si el campo oculto "website" tiene valor, es un bot
    if (p.website && p.website.length > 0) {
      return respond('ok'); // ignorar silenciosamente
    }

    var ts = new Date();
    saveToSheet(p, ts);
    sendNotificationEmail(p, ts);
    return respond('ok');

  } catch (err) {
    Logger.log('SIE Form Error: ' + err.toString());
    return respond('error');
  }
}

// ── Guardar en Google Sheets ─────────────────────────────
function saveToSheet(p, ts) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    var headers = [
      'Fecha/Hora (Caracas)', 'Nombre completo', 'Edad', 'Email',
      'Ciudad', 'WhatsApp', 'Semana elegida',
      'Proyecto o idea de negocio', 'Experiencia con IA',
      'Experiencia en ventas', 'Por qué quiere entrar', 'Comentarios'
    ];
    sheet.appendRow(headers);
    var hr = sheet.getRange(1, 1, 1, headers.length);
    hr.setFontWeight('bold');
    hr.setBackground('#F5A623');
    hr.setFontColor('#0a0a0a');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 175);
    sheet.setColumnWidth(8, 220);
    sheet.setColumnWidth(11, 260);
  }

  sheet.appendRow([
    Utilities.formatDate(ts, 'America/Caracas', 'dd/MM/yyyy HH:mm:ss'),
    p.nombre      || '',
    p.edad        || '',
    p.email       || '',
    p.ciudad      || '',
    p.whatsapp    || '',
    p.semana      || '',
    p.negocio     || '',
    p.ia          || '',
    p.ventas      || '',
    p.motivo      || '',
    p.comentarios || ''
  ]);
}

// ── Enviar correo de notificación ────────────────────────
function sendNotificationEmail(p, ts) {
  var fecha  = Utilities.formatDate(ts, 'America/Caracas', 'dd/MM/yyyy HH:mm:ss');
  var nombre = p.nombre || 'Sin nombre';
  var semana = p.semana || 'No especificada';

  var subject = 'Nueva inscripción SIE — ' + nombre + ' — ' + semana;

  var body = [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '  NUEVA INSCRIPCIÓN — Sprint de Inteligencia Empresarial',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '  Recibida el: ' + fecha + ' (hora Caracas)',
    '',
    '── DATOS DEL POSTULANTE ───────────────────',
    '  Nombre:    ' + (p.nombre   || '—'),
    '  Edad:      ' + (p.edad     || '—'),
    '  Email:     ' + (p.email    || '—'),
    '  WhatsApp:  ' + (p.whatsapp || '—'),
    '  Ciudad:    ' + (p.ciudad   || '—'),
    '  Semana:    ' + (p.semana   || '—'),
    '',
    '── PREGUNTAS DE CONOCIMIENTO ──────────────',
    '',
    '  Proyecto o idea de negocio:',
    '  ' + (p.negocio || '—'),
    '',
    '  Experiencia con herramientas de IA:',
    '  ' + (p.ia      || '—'),
    '',
    '  Experiencia en ventas:',
    '  ' + (p.ventas  || '—'),
    '',
    '  ★ POR QUÉ QUIERE ENTRAR:',
    '  ' + (p.motivo  || '—'),
    '',
    '  Comentarios adicionales:',
    '  ' + (p.comentarios || '—'),
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '  Enviado vía oscarb2b.com/sprint.html',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');

  MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: subject, body: body });
}

// ── Helper ───────────────────────────────────────────────
function respond(status) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: status }))
    .setMimeType(ContentService.MimeType.JSON);
}

/*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  INSTRUCCIONES DE DESPLIEGUE (solo se hace una vez)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Ve a sheets.google.com → crea una hoja nueva.
   Ponle el nombre que quieras (ej. "SIE Inscripciones 2026").

2. Menú superior: Extensiones > Apps Script
   Se abre el editor. Borra el código de ejemplo y pega ESTE archivo completo.

3. Guarda (Ctrl+S). Ponle nombre al proyecto (ej. "SIE Form Handler").

4. Clic en "Implementar" (arriba a la derecha) > "Nueva implementación"
   - Tipo de implementación:  Aplicación web
   - Ejecutar como:           Yo ([tu cuenta de Google])
   - Quién tiene acceso:      Cualquier usuario

5. Clic en "Implementar". Te pedirá que autorices permisos.
   Acepta todo (necesita acceso a Gmail para enviar y a Sheets para guardar).

6. Copia la "URL de la aplicación web" que aparece. Se ve así:
   https://script.google.com/macros/s/AKfycb.../exec

7. Abre sprint.html → busca esta línea al inicio del <script>:
      const FORM_ENDPOINT = 'TU_URL_AQUI';
   y pega la URL copiada entre las comillas.

8. Guarda, haz commit y push a GitHub. Listo.

NOTAS:
- Si cambias el código del script, debes crear una NUEVA implementación
  (Implementar > Nueva implementación) — no editar la existente.
- La hoja de Sheets se crea automáticamente la primera vez que alguien envíe
  el formulario. No tienes que crearla manualmente.
- El correo llega a: oscar@oscarb2b.com (variable NOTIFY_EMAIL arriba)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*/
