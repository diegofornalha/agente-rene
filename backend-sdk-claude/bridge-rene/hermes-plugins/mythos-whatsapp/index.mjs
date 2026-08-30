// Mythos WhatsApp Inbound — hermes plugin.
//
// Hook escolhido: `before_agent_reply` — broadcast pra todos plugins, primeiro
// retornando { handled: true, reply } ganha e curto-circuita o LLM agent.
// Disparado pelo pi-embedded antes do agente rodar (caminho de grupos).
//
// Não usamos `inbound_claim` porque, no dispatch atual do hermes, ele só
// dispara pra plugins com `pluginOwnedBinding` (binding 1:1 de conversa) —
// não é broadcast genérico.
//
// Filtros aplicados ANTES de chamar o backend:
//   - sessionKey contém ":whatsapp:group:" (só grupos WhatsApp)
//   - groupId extraído da sessionKey está em allowedGroups (vazio = todos)
//   - cleanedBody.length >= minLen (ignora "ok", emojis, stickers)
//
// Backend mythos retorna { reply, ... } se NotebookLM tem grounding pra pergunta.
// Sem reply (no-grounding/too-short/duplicate), o plugin não claim → agente embedded
// segue o fluxo normal (provavelmente NO_REPLY).

import { definePluginEntry } from "hermes/plugin-sdk/plugin-entry";

// sessionKey formato observado: "agent:main:whatsapp:group:120363426750630195@g.us"
function parseSessionKey(sessionKey) {
  if (!sessionKey || typeof sessionKey !== "string") return null;
  const m = sessionKey.match(/:(\w+):(group|dm|direct):(.+)$/);
  if (!m) return null;
  return { channel: m[1], chatType: m[2], conversationId: m[3] };
}

export default definePluginEntry({
  id: "mythos-whatsapp-inbound",
  name: "Mythos WhatsApp Inbound",
  description: "Intercepts WhatsApp group messages with NotebookLM-grounded replies via mythos backend.",
  register(api) {
    const cfg = api.pluginConfig || {};
    const backendUrl = cfg.backendUrl || "http://127.0.0.1:3456/api/whatsapp/inbound";
    const authToken  = typeof cfg.authToken === "string" ? cfg.authToken : "";
    const allowedGroups = Array.isArray(cfg.allowedGroups) ? cfg.allowedGroups : [];
    const minLen     = Number.isInteger(cfg.minLen) ? cfg.minLen : 8;
    const timeoutMs  = Number.isInteger(cfg.timeoutMs) ? cfg.timeoutMs : 60000;

    api.logger.info(
      `mythos-whatsapp: registered (before_agent_reply hook). backendUrl=${backendUrl} ` +
      `allowedGroups=${allowedGroups.length || 'ANY'} minLen=${minLen} timeoutMs=${timeoutMs}`
    );

    api.on("before_agent_reply", async (event, ctx) => {
      const text = (event?.cleanedBody || "").trim();
      const parsed = parseSessionKey(ctx?.sessionKey);

      api.logger.info(
        `mythos-whatsapp: before_agent_reply fired ` +
        `sessionKey=${ctx?.sessionKey} parsed=${JSON.stringify(parsed)} len=${text.length}`
      );

      // 1. Só WhatsApp em grupo
      if (!parsed) return;
      if (parsed.channel !== "whatsapp") return;
      if (parsed.chatType !== "group") return;

      // 2. Filtro de grupos permitidos
      if (allowedGroups.length && !allowedGroups.includes(parsed.conversationId)) return;

      // 3. Tamanho mínimo
      if (text.length < minLen) return;

      // 4. POST pro mythos
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const headers = { "Content-Type": "application/json" };
        if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
        const res = await fetch(backendUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            text,
            groupId: parsed.conversationId,
            channel: parsed.channel,
            sessionKey: ctx?.sessionKey,
            agentId: ctx?.agentId,
            messageId: ctx?.runId, // best-effort id pra dedup
            channelId: ctx?.channelId,
            replyToGroup: true, // mythos envia direto via whatsapp-send (Plano B)
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          api.logger.warn(`mythos-whatsapp: backend HTTP ${res.status}`);
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (!data?.reply) {
          if (data?.skipped) api.logger.info(`mythos-whatsapp: skipped=${data.skipped}`);
          return;
        }
        // Plano B: mythos já enviou via whatsapp-send (replyToGroup: true).
        // Plugin claim com NO_REPLY pra silenciar o agente embedded e
        // evitar duplicata, sem depender do auto-dispatch do framework.
        api.logger.info(
          `mythos-whatsapp: claimed sessionKey=${ctx?.sessionKey} ` +
          `replyLen=${data.reply.length} outboundOk=${data.outboundOk} ` +
          `outboundMessageId=${data.outboundMessageId || ''} ` +
          `outboundErr=${data.outboundErr || ''}`
        );
        return { handled: true, reply: { text: 'NO_REPLY' } };
      } catch (err) {
        api.logger.warn(`mythos-whatsapp: backend call failed: ${err.message}`);
        return;
      } finally {
        clearTimeout(t);
      }
    }, { priority: 1000, timeoutMs: 90000 });
  },
});
