// Shim — preserva require('../claude-query') de arquivos em bridge-lucrecia/services/*.
// Refator pra ctx.claudeQuery fica como tech debt; este shim evita refatorar 10 consumidores.
module.exports = require('../backend-sdk-claude/claude-query');
