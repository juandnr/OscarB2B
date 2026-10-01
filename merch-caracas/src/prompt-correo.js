'use strict';

// Prompt del sistema del clasificador de correos de F6. Al empaquetar para
// Supabase o n8n este módulo se reemplaza por el texto literal de prompts/correo.md.
const fs = require('fs');
const path = require('path');

module.exports = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'correo.md'), 'utf8');
