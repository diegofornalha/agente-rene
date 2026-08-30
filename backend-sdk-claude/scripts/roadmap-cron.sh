#!/bin/bash
# roadmap-cron.sh — Envia avisos diários do Roadmap Paraguai (Daniel) no grupo Rota Fiscal #333
# Executado pelo node-cron do backend (services/roadmap-cron.js) todo dia às 08:03, de 03/07 a 27/07/2026.
# Cada dia tem seus tópicos; se o dia não tem tarefa, não envia nada.

set -euo pipefail

API="http://localhost:3457/api/whatsapp/say"
# Token lido do .env do backend (mesmo idioma do lucas-unjam.sh), ancorado no
# diretório do script porque o execFile do roadmap-cron.js não garante o cwd.
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
TOKEN="$(grep -E '^API_BEARER_SECRET=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
JID="120363408372425998@g.us"
TODAY=$(date '+%d/%m')
LOG="/tmp/roadmap-cron.log"

if [ -z "$TOKEN" ]; then
  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') roadmap-cron ERRO: API_BEARER_SECRET não encontrado em $ENV_FILE" >> "$LOG"
  exit 1
fi

send() {
  local msg="$1"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"jid\":\"$JID\",\"text\":$(echo "$msg" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" \
    2>>"$LOG") || code="ERR"
  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') roadmap-cron dia=$TODAY http=$code jid=$JID" >> "$LOG"
  # HTTP 200 = entregue; qualquer outra coisa (000/ERR/4xx/5xx) fica registrado pra diagnóstico
}

case "$TODAY" in

"03/07")
send "📋 *Roadmap Paraguai — 03/07*

1️⃣ *Levantar toda documentação pessoal*
Reunir originais: RG, CPF, certidão nascimento/casamento, comprovante residência, passaporte.

2️⃣ *Tirar cópias autenticadas*
Ir ao cartório — autenticar RG, CPF, certidão, comprovante. Custo: R\$ 50-90.

3️⃣ *Apostilamento de Haia*
Apostilar certidão de nascimento e antecedentes criminais. Custo: R\$ 260-540. Prazo: 3-5 dias úteis — urgente!"
;;

"04/07")
send "📋 *Roadmap Paraguai — 04/07*

1️⃣ *Vacina febre amarela + CIVP* ✅ FEITA EM 01/07
Já antecipada! Emitir o CIVP no portal da Anvisa se ainda não fez.

2️⃣ *Certidões de antecedentes criminais*
Emitir online: Polícia Federal + Justiça Estadual + Justiça Federal. Gratuito. Validade 90 dias.

3️⃣ *Tradução juramentada para espanhol*
Contratar tradutor juramentado. Custo: R\$ 640-1.800. Prazo: 3-7 dias úteis. Enviar docs JÁ APOSTILADOS.

📱 *Conteúdo: Story/Reels da vacina*
Gravar story no posto — primeiro conteúdo de aquecimento da jornada."
;;

"05/07")
send "📋 *Roadmap Paraguai — 05/07*

1️⃣ *Foto 3x4 tipo passaporte*
Ir ao estúdio: 4 unidades, fundo branco, formato 3x4. Custo: R\$ 30-50."
;;

"06/07")
send "📋 *Roadmap Paraguai — 06/07*

📱 *Conteúdo: Carrossel '5 documentos que você não sabia que precisa pra sair do Brasil'*
Post educativo sobre documentação de expatriação. CTA: 'Quer saber como funciona? Me chama no DM'."
;;

"07/07")
send "📋 *Roadmap Paraguai — 07/07*

1️⃣ *Revisão: todos os documentos prontos?*
Checkpoint de final de semana — conferir RG, CPF, certidões, fotos, traduções. Listar o que falta.

2️⃣ *Sandero — Transferência concluída* ✅
Já feita em 01/07."
;;

"08/07")
send "📋 *Roadmap Paraguai — 08/07*

📱 *Conteúdo: Post 'Por que estou saindo do Brasil'*
Post texto longo ou vídeo sobre a motivação da expatriação. Tom pessoal, não pitch."
;;

"09/07")
send "📋 *Roadmap Paraguai — 09/07*

1️⃣ *New Fiesta — Anunciar venda*
Reparos concluídos → fotografar (mín. 10 fotos) → anunciar em OLX + Webmotors + Marketplace."
;;

"10/07")
send "📋 *Roadmap Paraguai — 10/07*

1️⃣ *Verificar IPVA/multas — ambos os veículos*
Consultar débitos pendentes por placa no Detran.

2️⃣ *Fechar pendências veiculares*
Sandero e New Fiesta — resolver tudo que ficou pendente."
;;

"11/07")
send "📋 *Roadmap Paraguai — 11/07*

1️⃣ *Resolver pendências bancárias*
Listar contas ativas, definir quais manter, encerrar desnecessárias, quitar empréstimos.

📱 *Conteúdo: Reels 'Brasil vs Paraguai — comparativo tributário'*
Vídeo curto com números reais (IR, ICMS, IVA PY). Máx 60-90s."
;;

"12/07")
send "📋 *Roadmap Paraguai — 12/07*

1️⃣ *Checkpoint: status dos dois carros*
Sandero transferido? New Fiesta vendido? Destravar o que parou.

2️⃣ *Diagnóstico tributário* ⚡ ANTECIPADO
Identificar regime atual, fontes de renda, CNPJ ativo, bens declarados no IR."
;;

"13/07")
send "📋 *Roadmap Paraguai — 13/07*

1️⃣ *Definir modalidade de residência*
Comum vs Investor Pass — comparar requisitos e custos.

2️⃣ *Consultar situação fiscal na Receita Federal* ⚡
Acessar e-CAC, emitir CND. Se der POSITIVA (com débitos): agir IMEDIATAMENTE."
;;

"14/07")
send "📋 *Roadmap Paraguai — 14/07*

1️⃣ *Verificar DIRPF pendente ou retificação*
Conferir se caiu em malha fina no e-CAC. Retificar se necessário.

📱 *Conteúdo: Post 'Quanto custa expatriar pro Paraguai — números reais'*
Breakdown de custos reais: R\$ 4k-9k sem copiloto. Formato carrossel."
;;

"15/07")
send "📋 *Roadmap Paraguai — 15/07*

1️⃣ *Planejar saída definitiva (DSDP)*
Entender CSDP + DSDP. Definir data oficial de saída fiscal. Comunicar fontes pagadoras."
;;

"16/07")
send "📋 *Roadmap Paraguai — 16/07*

1️⃣ *Reunir comprovantes de renda/patrimônio*
Holerites, extratos bancários (3 meses), última DIRPF, comprovante de bens. Necessário pra banco no Paraguai."
;;

"17/07")
send "📋 *Roadmap Paraguai — 17/07*

1️⃣ *Checkpoint: financeiro/tributário resolvido?*
CND emitida? DIRPF ok? DSDP planejada? Modalidade decidida?

2️⃣ *Confirmar passagem aérea* ⚡ ANTECIPADO
Voo 27/07 às 7h25. Preço sobe rápido nas últimas 2 semanas!

📱 *Conteúdo: Story bastidores 'preparando documentos'*
Fotografar pasta organizada com apostilas e traduções."
;;

"18/07")
send "📋 *Roadmap Paraguai — 18/07*

1️⃣ *Reservar hotel em Foz do Iguaçu*
Próximo à Ponte da Amizade. 1-2 noites. R\$ 150-300/noite.

2️⃣ *Agendar compromissos em CDE* ⚡ ANTECIPADO
Migraciones, banco, contador. Agenda limitada — fazer HOJE!

📱 *Conteúdo: Reels 'Contagem regressiva — 9 dias'*
Vídeo curto com passagem, mapa, pasta de docs."
;;

"19/07")
send "📋 *Roadmap Paraguai — 19/07*

1️⃣ *Reservar hotel em Ciudad del Este*
Se for pernoitar no lado paraguaio. USD 40-80/noite."
;;

"20/07")
send "📋 *Roadmap Paraguai — 20/07*

1️⃣ *Preparar pasta física com documentos*
Montar pasta definitiva: originais + cópias + traduções + apostilamentos. BAGAGEM DE MÃO!

2️⃣ *Providenciar dólares em espécie* ⚡
USD 300-500 em notas de 50 e 100. Cotar em 2-3 casas de câmbio."
;;

"21/07")
send "📋 *Roadmap Paraguai — 21/07*

📱 *Conteúdo: Post 'O que levar numa viagem de expatriação'*
Checklist visual: docs, dólares, roupas, eletrônicos. CTA: 'Salva esse post'."
;;

"22/07")
send "📋 *Roadmap Paraguai — 22/07*

1️⃣ *Confirmar transporte Foz → CDE*
Táxi, transfer privado ou ônibus. Reservar e confirmar. Tempo de travessia: 30min a 2h."
;;

"23/07")
send "📋 *Roadmap Paraguai — 23/07*

1️⃣ *Veículos: confirmar conclusão*
Sandero com CRV no nome do Diego? New Fiesta vendido? Procuração se não fechou.

2️⃣ *Revisar checklist completo*
Varredura geral: documentos, financeiro, logística. Certidões ainda válidas?

📱 *Conteúdo: Stories contagem regressiva diária*
'4 dias. Mala quase pronta. Documentos conferidos.'"
;;

"24/07")
send "📋 *Roadmap Paraguai — 24/07*

1️⃣ *Imprimir reservas e contatos úteis*
Passagem, hotel, itinerário, lista de contatos. Backup sem internet.

2️⃣ *Contingência: resolver pendências*
ÚLTIMA CHANCE. Priorizar por criticidade. Margem zero a partir daqui.

3️⃣ *Fazer mala*
Docs → BAGAGEM DE MÃO. Dólares → bolso. Roupas 3-5 dias (inverno ~15-25°C)."
;;

"25/07")
send "📋 *Roadmap Paraguai — 25/07*

1️⃣ *Celular: roaming ou chip local*
Habilitar roaming OU planejar compra de chip paraguaio na chegada.

2️⃣ *Check-in online do voo*
Fazer check-in 48h antes (voo 27/07).

3️⃣ *Descansar. Tudo pronto.*
Conferir alarme (sair ~5h), pasta na mala de mão, dólares e cartões. Dormir cedo.

📱 *Conteúdo: Post pré-lançamento 'Em 48h tudo muda'*
Último post orgânico antes da viagem."
;;

"26/07")
send "📋 *Roadmap Paraguai — 26/07*

🔔 *VÉSPERA DO DIA D*
Amanhã é o grande dia. Conferir:
✅ Pasta de documentos na mala de mão
✅ Dólares em espécie separados
✅ Check-in do voo feito
✅ Alarme pra 4h30 (sair às 5h)
✅ Reservas impressas

📱 Story: 'Amanhã. Pronto pra um novo capítulo.'"
;;

"27/07")
send "🛫 *DIA D — ROADMAP PARAGUAI*

05:00 — Sair para o aeroporto
07:25 — Voo → Foz do Iguaçu
Chegada — Transfer pro hotel ou direto pra Ponte da Amizade
PM — Primeiro contato em Ciudad del Este

Boa viagem! 🇵🇾"
;;

*)
  # Dia sem tarefa no roadmap — não envia nada
  exit 0
  ;;
esac
