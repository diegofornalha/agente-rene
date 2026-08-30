// Lucro Ativo — Grupos Operacionais WhatsApp.
//
// Registra a tool `create_operational_group` que o agente invoca após
// `criar-documento-opensign --send` bem-sucedido. Junta fixos do team.json
// (Lucas, Peter, Priscila) com representante do cliente + testemunhas e cria
// o grupo no WhatsApp da própria sessão Baileys do OpenClaw bot.
//
// FASE A (atual): dryRun=true → não toca em Baileys, só monta+loga+persiste
// JID fake. Permite validar amarração com fluxo OpenSign sem risco zero.
//
// FASE B (real, v0.2): substituiu o motor WhatsApp da Lucrécia
// (Baileys/OpenClaw → whatsmeow local via wuzapi). Plugin chama HTTP local em
// 127.0.0.1:18790 (wuzapi container, sessão `lucrecia` pareada com o número
// da Lucrécia). Lucrécia é criadora/admin do grupo (whatsmeow adiciona o
// próprio bot implicitamente), participants vem do team.json + cliente.
// Mensagem inicial sai pela mesma sessão (Lucrécia é admin → coerência total
// de identidade do começo ao fim).
//
// Plano de referência: ~/.claude/plans/greedy-orbiting-diffie.md

import { definePluginEntry } from "hermes/plugin-sdk/plugin-entry";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const TOOL_NAME = "create_operational_group";

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Normaliza telefone BR/internacional pra JID do WhatsApp.
// - "+55 11 99999-0000" → "5511999990000@s.whatsapp.net"
// - "11 99999-0000"     → "5511999990000@s.whatsapp.net"  (assume Brasil quando 10-11 dígitos)
// - "11 1234-5678"      → "551112345678@s.whatsapp.net"   (fixo BR 10 dígitos)
// - já com 12-13 dígitos começando com 55 → mantém
// - outros 12+ dígitos sem 55 → mantém (assume internacional já formatado)
function normalizePhoneToJid(raw) {
  if (typeof raw !== "string") return null;
  let digits = raw.replace(/\D+/g, "");
  if (!digits || digits === "TBD") return null;
  if (digits.length === 10 || digits.length === 11) {
    // BR sem código país (DDD + número)
    digits = "55" + digits;
  }
  if (digits.length < 12) return null;
  return `${digits}@s.whatsapp.net`;
}

function collectParticipants({ team, client }) {
  const out = [];
  const seen = new Set();
  const skipped = [];

  const add = (nome, phoneRaw, origem) => {
    const jid = normalizePhoneToJid(phoneRaw);
    if (!jid) {
      skipped.push({ nome, phoneRaw, origem, motivo: "phone_invalido_ou_TBD" });
      return;
    }
    if (seen.has(jid)) return;
    seen.add(jid);
    out.push({ nome, jid, origem });
  };

  for (const f of team?.fixos ?? []) add(f.nome, f.phone, "fixo");

  const rep = client?.representante;
  if (rep) add(rep.nome, rep.phone, "representante");

  for (const t of client?.testemunhas ?? []) add(t.nome, t.phone, "testemunha");

  return { participantes: out, ignorados: skipped };
}

function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] !== undefined ? String(vars[k]) : `{${k}}`
  );
}

function persistGroupJidInClient(clientPath, jid, dryRun) {
  const obj = loadJson(clientPath);
  obj.grupo_operacional_jid = jid;
  obj.grupo_operacional_dry_run = !!dryRun;
  obj.atualizado_em = new Date().toISOString();
  writeFileSync(clientPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function textResult(text, details) {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

// Chamada HTTP simples ao wuzapi com timeout + AbortController. Retorna
// { ok, data, error?, status? } padronizado pra facilitar tratamento no execute().
async function callWuzapi({ baseUrl, token, path, body, timeoutMs, upstreamSignal }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
  const onUpstreamAbort = () => ctrl.abort("upstream-abort");
  upstreamSignal?.addEventListener?.("abort", onUpstreamAbort);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Token": token,
      },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (!res.ok || parsed?.success === false) {
      return {
        ok: false,
        status: res.status,
        error: `wuzapi ${res.status}: ${(parsed?.error || text).slice(0, 300)}`,
        body: parsed,
      };
    }
    return { ok: true, data: parsed?.data, status: res.status };
  } catch (err) {
    return { ok: false, error: `fetch failed: ${err.message}` };
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener?.("abort", onUpstreamAbort);
  }
}

export default definePluginEntry({
  id: "wagner-wa-groups",
  name: "Lucro Ativo — Grupos Operacionais WhatsApp",
  description: "Cria/atualiza grupo operacional WhatsApp pós-disparo OpenSign.",
  register(api) {
    const cfg = api.pluginConfig || {};
    const dryRun = cfg.dryRun !== false; // default: true
    const teamPath = cfg.teamPath || "/home/lucrecia/.hermes-claw-lucrecia/opensign-bridge/team.json";
    const clientsDir = cfg.clientsDir || "/home/lucrecia/.claude/skills/cadastro-cliente-opensign/clients";
    const subjectTemplate = cfg.subjectTemplate || "LA: {doc_titulo}";
    const mensagemInicialTemplate = cfg.mensagemInicialTemplate ||
      'Grupo operacional do contrato "{doc_titulo}" com {razao_social}. Documento foi enviado pra assinatura. Aviso aqui quando todos assinarem.';

    // Wuzapi (motor WhatsApp da Lucrécia). Capturados no closure pra evitar bug
    // conhecido de pluginConfig indisponível dentro de execute().
    const wuzapiBaseUrl = cfg.wuzapiBaseUrl || "http://127.0.0.1:18790";
    const wuzapiToken = cfg.wuzapiToken || "";
    const wuzapiTimeoutMs = Number(cfg.wuzapiTimeoutMs) || 15000;

    api.logger.info(
      `wagner-wa-groups: registered. dryRun=${dryRun} teamPath=${teamPath} clientsDir=${clientsDir} ` +
      `wuzapiBaseUrl=${wuzapiBaseUrl} wuzapiToken=${wuzapiToken ? "(set)" : "(EMPTY)"}`
    );

    api.registerTool({
      name: TOOL_NAME,
      label: "Criar grupo operacional WhatsApp",
      description:
        "Cria (ou atualiza) o grupo operacional WhatsApp para acompanhamento de um contrato Lucro Ativo já disparado pelo OpenSign. Idempotente por client_slug. Em dry-run, simula tudo sem tocar no WhatsApp.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["client_slug", "doc_titulo"],
        properties: {
          client_slug: {
            type: "string",
            description: "Slug do cliente em ~/.claude/skills/cadastro-cliente-opensign/clients/<slug>.json",
          },
          doc_titulo: {
            type: "string",
            description: "Título do documento que foi disparado (ex.: 'NDA — versão 2025')",
          },
          doc_objectId: {
            type: "string",
            description: "objectId do contracts_Document no OpenSign (opcional)",
          },
        },
      },
      execute: async (toolCallId, params /* , signal, onUpdate */) => {
        const { client_slug, doc_titulo, doc_objectId } = params || {};
        if (!client_slug || !doc_titulo) {
          return textResult(
            "ERRO: client_slug e doc_titulo são obrigatórios.",
            { ok: false, error: "missing_required_params" }
          );
        }

        const clientPath = join(clientsDir, `${client_slug}.json`);
        if (!existsSync(clientPath)) {
          return textResult(
            `ERRO: cliente não encontrado: ${clientPath}`,
            { ok: false, error: "client_not_found", clientPath }
          );
        }

        let team, client;
        try {
          team = loadJson(teamPath);
          client = loadJson(clientPath);
        } catch (err) {
          return textResult(
            `ERRO: falha ao ler config: ${err.message}`,
            { ok: false, error: "config_read_failed" }
          );
        }

        const razaoSocial = client?.pj?.razao_social || client_slug;
        const subject = renderTemplate(subjectTemplate, { doc_titulo, razao_social: razaoSocial });
        const mensagemInicial = renderTemplate(mensagemInicialTemplate, {
          doc_titulo,
          razao_social: razaoSocial,
        });

        const { participantes, ignorados } = collectParticipants({ team, client });

        if (ignorados.length) {
          api.logger.warn(
            `wagner-wa-groups: ${ignorados.length} participante(s) ignorado(s): ` +
            ignorados.map((i) => `${i.nome}(${i.origem}/${i.motivo})`).join(", ")
          );
        }

        const jaExistia = !!client?.grupo_operacional_jid;
        const jidExistente = client?.grupo_operacional_jid || null;

        // ─────────────── DRY-RUN (Fase A) ───────────────
        if (dryRun) {
          const fakeJid = jaExistia
            ? jidExistente
            : `120363DRYRUN${Date.now()}@g.us`;

          api.logger.info(
            `wagner-wa-groups[DRY-RUN]: ${jaExistia ? "JÁ EXISTIA" : "CRIARIA"} ` +
            `client_slug=${client_slug} subject="${subject}" jid=${fakeJid} ` +
            `participantes=${participantes.length} ignorados=${ignorados.length}`
          );
          api.logger.info(
            `wagner-wa-groups[DRY-RUN]: participantes=${JSON.stringify(participantes)}`
          );
          api.logger.info(
            `wagner-wa-groups[DRY-RUN]: mensagemInicial="${mensagemInicial}"`
          );

          if (!jaExistia) {
            try {
              persistGroupJidInClient(clientPath, fakeJid, true);
            } catch (err) {
              return textResult(
                `ERRO: falha ao persistir JID fake: ${err.message}`,
                { ok: false, error: "persist_failed" }
              );
            }
          }

          const summary =
            (jaExistia ? "Grupo JÁ EXISTIA" : "Grupo SERIA criado") +
            ` (DRY-RUN)\n` +
            `  client_slug: ${client_slug}\n` +
            `  subject: ${subject}\n` +
            `  jid: ${fakeJid}\n` +
            `  participantes (${participantes.length}): ${participantes.map((p) => `${p.nome} [${p.origem}]`).join(", ") || "—"}\n` +
            (ignorados.length
              ? `  ignorados (${ignorados.length}): ${ignorados.map((i) => `${i.nome} [${i.motivo}]`).join(", ")}\n`
              : "") +
            `  mensagem_inicial: ${mensagemInicial}`;

          return textResult(summary, {
            ok: true,
            dry_run: true,
            criado: !jaExistia,
            ja_existia: jaExistia,
            groupJid: fakeJid,
            subject,
            mensagem_inicial: mensagemInicial,
            participantes,
            ignorados,
            doc_objectId: doc_objectId || null,
          });
        }

        // ─────────────── REAL (Fase B — via wuzapi local) ───────────────
        if (!wuzapiToken) {
          return textResult(
            "ERRO: wuzapiToken não configurado. Setar em hermes.json: " +
            "plugins.entries.wagner-wa-groups.config.wuzapiToken",
            { ok: false, error: "wuzapi_token_missing" }
          );
        }

        // Idempotência em modo real: se já existe, NÃO re-cria nem re-envia
        // mensagem inicial (evita spam em grupo já notificado).
        if (jaExistia) {
          api.logger.info(
            `wagner-wa-groups[REAL]: JÁ EXISTIA — skip create. client_slug=${client_slug} jid=${jidExistente}`
          );
          return textResult(
            `Grupo já existia: ${jidExistente}. Skipando re-criação (idempotência).\n` +
            `Pra forçar re-criação: editar clients/${client_slug}.json removendo grupo_operacional_jid.`,
            {
              ok: true,
              dry_run: false,
              criado: false,
              ja_existia: true,
              groupJid: jidExistente,
              subject,
              participantes,
              ignorados,
              doc_objectId: doc_objectId || null,
            }
          );
        }

        // Defensiva 25-char (limite WhatsApp do nome do grupo, retorna 406 senão)
        const subjectShort = subject.length > 25 ? subject.slice(0, 25) : subject;

        // wuzapi /group/create espera phones puros (sem @s.whatsapp.net).
        // Lucrécia (a sessão pareada) é adicionada implicitamente pelo whatsmeow
        // como criadora/admin — NÃO incluir nos participants.
        const phonesPlanos = participantes.map((p) => p.jid.split("@")[0]);

        api.logger.info(
          `wagner-wa-groups[REAL]: criando grupo. client_slug=${client_slug} ` +
          `subject="${subjectShort}" participants=${phonesPlanos.length}`
        );

        const createResult = await callWuzapi({
          baseUrl: wuzapiBaseUrl,
          token: wuzapiToken,
          path: "/group/create",
          body: { name: subjectShort, participants: phonesPlanos },
          timeoutMs: wuzapiTimeoutMs,
        });

        if (!createResult.ok) {
          api.logger.error(`wagner-wa-groups[REAL]: create failed: ${createResult.error}`);
          return textResult(
            `ERRO criando grupo: ${createResult.error}`,
            { ok: false, error: "wuzapi_create_failed", details: createResult }
          );
        }

        const groupJid = createResult.data?.JID || createResult.data?.jid;
        if (!groupJid) {
          return textResult(
            `ERRO: wuzapi retornou sem JID: ${JSON.stringify(createResult.data)}`,
            { ok: false, error: "wuzapi_no_jid", body: createResult.data }
          );
        }

        try {
          persistGroupJidInClient(clientPath, groupJid, false);
        } catch (err) {
          api.logger.warn(`wagner-wa-groups[REAL]: grupo ${groupJid} criado mas falhou persistir JID: ${err.message}`);
          // Não falha — grupo já existe no WhatsApp. Operador pode persistir manual.
        }

        // VALIDAÇÃO REAL ANTI-FALSO-500 (2026-05-16): wuzapi retorna
        // HTTP 500 + {"success":true} mesmo quando participantes não entram.
        // GET /group/info pra comparar Participants reais vs solicitados.
        // Se faltarem, tenta retry uma vez via updateparticipants.
        await new Promise((res) => setTimeout(res, 1500));
        let realParts = [];
        let participantesFaltando = phonesPlanos;
        try {
          const infoR = await callWuzapi({
            baseUrl: wuzapiBaseUrl,
            token: wuzapiToken,
            path: `/group/info?groupJID=${encodeURIComponent(groupJid)}`,
            method: "GET",
            timeoutMs: wuzapiTimeoutMs,
          });
          realParts = (infoR.data?.Participants || []).map((p) =>
            String(p.PhoneNumber || "").replace("@s.whatsapp.net", "").replace(/\D/g, "")
          );
          participantesFaltando = phonesPlanos.filter((p) => !realParts.includes(p));
        } catch (e) {
          api.logger.warn(`wagner-wa-groups[REAL]: /group/info follow-up falhou: ${e.message}`);
        }
        if (participantesFaltando.length > 0) {
          api.logger.warn(
            `wagner-wa-groups[REAL]: ${participantesFaltando.length}/${phonesPlanos.length} participantes não entraram. Tentando retry: ${participantesFaltando.join(",")}`
          );
          try {
            await callWuzapi({
              baseUrl: wuzapiBaseUrl,
              token: wuzapiToken,
              path: "/group/updateparticipants",
              body: { GroupJID: groupJid, Phone: participantesFaltando, Action: "add" },
              timeoutMs: wuzapiTimeoutMs,
            });
            await new Promise((res) => setTimeout(res, 1500));
            const infoR2 = await callWuzapi({
              baseUrl: wuzapiBaseUrl,
              token: wuzapiToken,
              path: `/group/info?groupJID=${encodeURIComponent(groupJid)}`,
              method: "GET",
              timeoutMs: wuzapiTimeoutMs,
            });
            realParts = (infoR2.data?.Participants || []).map((p) =>
              String(p.PhoneNumber || "").replace("@s.whatsapp.net", "").replace(/\D/g, "")
            );
            participantesFaltando = phonesPlanos.filter((p) => !realParts.includes(p));
          } catch (e) {
            api.logger.warn(`wagner-wa-groups[REAL]: retry updateparticipants falhou: ${e.message}`);
          }
        }

        // Mensagem inicial: PREFERE template "links de assinatura" via
        // gerarMsgLinksAssinatura(doc_objectId) quando há doc com signers
        // pendentes. Senão cai no template estático configurado.
        // Lição 2026-05-16: Lucas pediu "lista de links por signer no grupo
        // recém-criado, exceto owner Lucas que auto-assina".
        let bodyMsg = mensagemInicial;
        if (doc_objectId) {
          try {
            const { gerarMsgLinksAssinatura } = await import(
              "../../services/opensign/grupo-msg-inicial.js"
            ).then((m) => m.default || m).catch(() => null) || {};
            // ESM dynamic import de CJS exporta como default; fallback explicit
            const fn = gerarMsgLinksAssinatura
              || (await import("../../services/opensign/grupo-msg-inicial.js")).default?.gerarMsgLinksAssinatura;
            if (typeof fn === "function") {
              const msgLinks = await fn(doc_objectId, {});
              if (msgLinks && typeof msgLinks === "string" && msgLinks.length > 30) {
                bodyMsg = msgLinks;
              }
            }
          } catch (e) {
            api.logger.warn(`wagner-wa-groups[REAL]: gerarMsgLinksAssinatura falhou (usando template estático): ${e.message}`);
          }
        }

        const sendResult = await callWuzapi({
          baseUrl: wuzapiBaseUrl,
          token: wuzapiToken,
          path: "/chat/send/text",
          body: { Phone: groupJid, Body: bodyMsg },
          timeoutMs: wuzapiTimeoutMs,
        });

        const initialMessageStatus = sendResult.ok
          ? `enviada (msgId=${sendResult.data?.Id})`
          : `FALHOU - ${sendResult.error}`;

        api.logger.info(
          `wagner-wa-groups[REAL]: grupo ${groupJid} criado. ` +
          `Msg inicial: ${initialMessageStatus}`
        );

        return textResult(
          `Grupo criado: ${groupJid}\n` +
          `  subject: ${subjectShort}\n` +
          `  participantes solicitados (${participantes.length}): ${participantes.map((p) => `${p.nome} [${p.origem}]`).join(", ") || "—"}\n` +
          `  participantes REAIS no grupo: ${realParts.length}/${phonesPlanos.length}\n` +
          (participantesFaltando.length
            ? `  ⚠️ FALTANDO (${participantesFaltando.length}): ${participantesFaltando.join(", ")} (verificar se têm WhatsApp ativo ou privacidade bloqueia add)\n`
            : "  ✅ todos entraram no grupo\n") +
          (ignorados.length
            ? `  ignorados antes da chamada wuzapi (${ignorados.length}): ${ignorados.map((i) => `${i.nome} [${i.motivo}]`).join(", ")}\n`
            : "") +
          `  msg inicial: ${initialMessageStatus}` +
          (bodyMsg !== mensagemInicial ? " (usando msg de links de assinatura)" : ""),
          {
            ok: true,
            dry_run: false,
            criado: true,
            ja_existia: false,
            groupJid,
            subject: subjectShort,
            participantes,
            participantes_reais_count: realParts.length,
            participantes_faltando: participantesFaltando,
            ignorados,
            initial_message: {
              sent: sendResult.ok,
              messageId: sendResult.data?.Id,
              error: sendResult.ok ? undefined : sendResult.error,
              tipo: bodyMsg !== mensagemInicial ? "links_assinatura" : "template_estatico",
            },
            doc_objectId: doc_objectId || null,
          }
        );
      },
    });
  },
});
