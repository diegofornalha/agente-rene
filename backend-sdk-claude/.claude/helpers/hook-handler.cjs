#!/usr/bin/env node
'use strict';
// hook-handler.cjs — pre-bash guard contra exfiltração de credenciais e comandos destrutivos.
//
// Registrado como hook PreToolUse (matcher Bash) em .claude/settings.json; o Claude Code
// spawnado pelo task-runner roda com cwd em backend-sdk-claude/, então este settings de
// projeto vale pra todas as tasks com workspace default.
//
// Contrato (ver tests/hook-prebash.test.js):
//   stdin JSON  → { command } (teste) ou { tool_input: { command }, ... } (Claude Code real)
//   permitido   → exit 0, stdout "[OK]"
//   bloqueado   → stderr "[BLOCKED] <razão>"; exit 1 no shape de teste, exit 2 no shape
//                 real — o protocolo de hooks do Claude Code só trata exit 2 como bloqueio
//                 (exit 1 é erro não-bloqueante), enquanto a suíte espera exit 1.
//   HERMES_BASH_ALLOW_SECRETS=1 → bypassa APENAS os guards de credencial; os padrões
//                 destrutivos continuam valendo.
//   modo desconhecido / JSON inválido → exit 0 (permissivo: nunca derrubar o agente por
//                 falha do próprio guard).

// Sempre bloqueados, sem bypass.
const DESTRUCTIVE_PATTERNS = [
  // rm -rf apontando pra raiz (não bloqueia rm -rf /tmp/x etc.)
  [/\brm\s+(?:-[^\s]+\s+)*-[^\s]*(?:r[^\s]*f|f[^\s]*r)[^\s]*\s+\/+\*?(?:\s|$|;)/, 'rm -rf na raiz do filesystem'],
  [/\bformat\s+c:/i, 'format de disco'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'fork bomb'],
  // download-and-exec: curl/wget com pipe pra shell
  [/\b(?:curl|wget)\b[^|]*\|\s*(?:ba|z|da)?sh\b/, 'download com pipe pra shell'],
  [/\/dev\/tcp\//, 'reverse shell via /dev/tcp'],
  // persistência em shell rc (só redirect; leitura é livre)
  [/>{1,2}\s*(?:~|\$HOME|\/home\/[^\s\/]+|\/Users\/[^\s\/]+)\/\.(?:bashrc|zshrc|profile)\b/, 'escrita em shell rc'],
  [/>{1,2}\s*\S*authorized_keys\b/, 'injeção em authorized_keys'],
  [/(^|[^\w-])sudo(\s|$)/, 'escalação via sudo'],
];

// Bloqueados salvo HERMES_BASH_ALLOW_SECRETS=1.
// Padrões com boundary à direita pra não casar .sshfoo, *.sshd, my.aws,
// file.envsubst, whatsapp-auth-bkp etc.
const CREDENTIAL_PATTERNS = [
  [/\.claude\/\.?credentials\.json/, 'credenciais do Claude'],
  [/\.ssh(?:\/|\s|$|["'|;])/, 'diretório ~/.ssh'],
  [/\.aws\/(?:credentials|config)\b/, 'credenciais AWS'],
  [/\.config\/gh\/hosts\.ya?ml/, 'token do GitHub CLI'],
  [/\.env(?:\s|$|["';|])/, 'arquivo .env do projeto'],
  [/whatsapp-auth(?:\/|\s|$|["';|])/, 'sessão do WhatsApp (data/whatsapp-auth)'],
];

function check(command) {
  for (const [re, reason] of DESTRUCTIVE_PATTERNS) {
    if (re.test(command)) return reason;
  }
  if (process.env.HERMES_BASH_ALLOW_SECRETS !== '1') {
    for (const [re, reason] of CREDENTIAL_PATTERNS) {
      if (re.test(command)) return reason;
    }
  }
  return null;
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

async function main() {
  if (process.argv[2] !== 'pre-bash') process.exit(0);

  let data;
  try {
    data = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }

  const fromClaudeCode = data && typeof data.tool_input === 'object' && data.tool_input !== null;
  const command = fromClaudeCode ? data.tool_input.command : data && data.command;
  if (typeof command !== 'string') process.exit(0);

  const reason = check(command);
  if (reason) {
    process.stderr.write(`[BLOCKED] ${reason}\n`);
    process.exit(fromClaudeCode ? 2 : 1);
  }
  process.stdout.write('[OK]\n');
  process.exit(0);
}

main();
