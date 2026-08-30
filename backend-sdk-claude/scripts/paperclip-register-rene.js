// Registra o René como agente no Paperclip (adapter http → paperclip-bridge).
// Idempotente: se já existe agente "René" na empresa, reaproveita.
// NÃO imprime secrets — grava em .env e data/paperclip-agent.env (chmod 600).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const PAPERCLIP = process.env.PAPERCLIP_API_URL || 'http://127.0.0.1:3100';
const BRIDGE_PORT = process.env.PAPERCLIP_BRIDGE_PORT || '3459';
const ENV_FILE = path.join(ROOT, '.env');
const AGENT_ENV_FILE = path.join(ROOT, 'data', 'paperclip-agent.env');

async function api(method, p, body) {
  const r = await fetch(`${PAPERCLIP}/api${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${text.slice(0, 300)}`);
  return data;
}

function upsertEnvVar(file, key, value) {
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${key}=${value}`);
  } else {
    if (content && !content.endsWith('\n')) content += '\n';
    content += `${key}=${value}\n`;
  }
  fs.writeFileSync(file, content);
}

(async () => {
  const companies = await api('GET', '/companies');
  const company = companies.find((c) => c.name === 'Lucro Ativo') || companies[0];
  if (!company) throw new Error('nenhuma empresa no Paperclip');
  console.log(`empresa: ${company.name} (${company.id})`);

  // webhook secret (reusa o do .env se já existir)
  let webhookSecret = process.env.PAPERCLIP_WEBHOOK_SECRET;
  if (!webhookSecret) {
    webhookSecret = crypto.randomBytes(32).toString('hex');
    upsertEnvVar(ENV_FILE, 'PAPERCLIP_WEBHOOK_SECRET', webhookSecret);
    console.log('PAPERCLIP_WEBHOOK_SECRET gerado e gravado no .env');
  } else {
    console.log('PAPERCLIP_WEBHOOK_SECRET já existia no .env — reusando');
  }
  upsertEnvVar(ENV_FILE, 'PAPERCLIP_API_URL', PAPERCLIP);
  upsertEnvVar(ENV_FILE, 'PAPERCLIP_BRIDGE_PORT', BRIDGE_PORT);

  // agente (idempotente por nome)
  const agents = await api('GET', `/companies/${company.id}/agents`);
  let agent = agents.find((a) => a.name === 'René');
  const adapterConfig = {
    url: `http://127.0.0.1:${BRIDGE_PORT}/wake`,
    headers: { 'x-paperclip-secret': webhookSecret },
    timeoutMs: 15000,
  };
  if (!agent) {
    agent = await api('POST', `/companies/${company.id}/agents`, {
      name: 'René',
      role: 'general',
      title: 'Agente operacional (WhatsApp, conteúdo, infra, fiscal)',
      adapterType: 'http',
      adapterConfig,
      capabilities:
        'Agente Claude (backend próprio no debian). WhatsApp completo, geração de conteúdo (carrosséis, landings, vídeo Reels), deploy de subdomínios, Twenty CRM, skills fiscais Lucro Ativo (Tábula, PGFN, Rota Fiscal). Executa bash/código no workspace.',
    });
    console.log(`agente criado: ${agent.id}`);
  } else {
    await api('PATCH', `/agents/${agent.id}`, { adapterConfig, replaceAdapterConfig: true });
    console.log(`agente já existia (${agent.id}) — adapterConfig atualizado`);
  }

  // agent API key (para o René chamar o Paperclip de volta)
  const keys = await api('GET', `/agents/${agent.id}/keys`);
  const hasEnvFile = fs.existsSync(AGENT_ENV_FILE);
  const activeKey = keys.find((k) => !k.revokedAt);
  if (!activeKey || !hasEnvFile) {
    const key = await api('POST', `/agents/${agent.id}/keys`, { name: 'lucas-bridge' });
    const token = key.token || key.key || key.secret;
    if (!token) throw new Error(`key criada mas resposta sem token: campos=${Object.keys(key).join(',')}`);
    const lines = [
      `export PAPERCLIP_API_URL=${PAPERCLIP}`,
      `export PAPERCLIP_API_KEY=${token}`,
      `export PAPERCLIP_AGENT_ID=${agent.id}`,
      `export PAPERCLIP_COMPANY_ID=${company.id}`,
      '',
    ].join('\n');
    fs.writeFileSync(AGENT_ENV_FILE, lines, { mode: 0o600 });
    console.log(`agent key criada (${key.id}) e gravada em data/paperclip-agent.env (600)`);
  } else {
    console.log('agent key ativa + env file já existem — nada a fazer');
  }

  console.log('\nresumo:');
  console.log(`  companyId: ${company.id}`);
  console.log(`  agentId:   ${agent.id}`);
  console.log(`  webhook:   http://127.0.0.1:${BRIDGE_PORT}/wake`);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
