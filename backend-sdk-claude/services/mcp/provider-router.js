// Provider Router (esqueleto F4.14) — escolhe provider por task com
// fallback chain. Hoje o mythos só usa Anthropic via Claude Code SDK;
// este módulo serve pra estender quando adicionarmos OpenRouter, OpenAI,
// Google ou um endpoint OpenAI-compat local.
//
// Config: data/providers.json
// {
//   "default": "anthropic",
//   "fallbackChain": ["anthropic", "openrouter"],
//   "providers": {
//     "anthropic":  { "type": "claude-code-sdk", "credentialPool": ["ANTHROPIC_API_KEY"] },
//     "openrouter": { "type": "openai-compat", "baseURL": "https://openrouter.ai/api/v1", "credentialPool": ["OPENROUTER_API_KEY"] }
//   }
// }

const fs = require('fs-extra');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', '..', 'data', 'providers.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {
      default: 'anthropic',
      fallbackChain: ['anthropic'],
      providers: { anthropic: { type: 'claude-code-sdk', credentialPool: ['ANTHROPIC_API_KEY'] } },
    };
  }
  return fs.readJsonSync(CONFIG_FILE);
}

function pickCredential(provider) {
  const pool = provider.credentialPool || [];
  for (const envName of pool) {
    const value = process.env[envName];
    if (value) return { envName, value };
  }
  return null;
}

// Stub — quando provider != anthropic, levantamos pra avisar que falta implementar
async function dispatch({ prompt, options }) {
  const cfg = loadConfig();
  const providerName = cfg.default;
  const provider = cfg.providers[providerName];
  if (!provider) throw new Error(`provider ${providerName} não configurado`);

  if (provider.type === 'claude-code-sdk') {
    // path atual (claude-query.js já cobre)
    return { providerUsed: providerName, viaClaudeCodeSDK: true };
  }
  throw new Error(`provider type "${provider.type}" não implementado — fica como TODO da Fase 4`);
}

module.exports = { loadConfig, pickCredential, dispatch };
