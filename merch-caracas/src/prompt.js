'use strict';

// Prompt del sistema de F2. Al construir los flujos de n8n este módulo se
// reemplaza por el texto literal de prompts/clasificador.md.
const fs = require('fs');
const path = require('path');

module.exports = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'clasificador.md'), 'utf8');
