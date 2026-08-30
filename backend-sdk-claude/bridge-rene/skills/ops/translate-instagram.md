---
name: translate-instagram
description: Processa pedido de tradução de Instagram — baixa imagens, traduz para PT-BR, envia via WhatsApp. Disparado pelo agente hermes.
---

# Traduzir Instagram

## 1. Baixar imagens do post

```bash
cd /Users/2a/.hermes/workspace/scripts
uv run download-instagram.py "URL_DO_POST"
```

Retorna lista de arquivos salvos em `/Users/2a/.hermes/workspace/media/images/ig_SHORTCODE_N.jpg`

## 2. Traduzir para PT-BR

```bash
cd /Users/2a/.hermes/workspace/scripts
for f in /Users/2a/.hermes/workspace/media/images/ig_SHORTCODE_*.jpg; do
  name=$(basename "$f" .jpg)
  uv run translate-image.py -i "$f" -f "/Users/2a/.hermes/workspace/media/translated/${name}_ptbr.png"
done
```

## 3. Enviar via WhatsApp

```bash
# Texto de contexto
curl -s -X POST http://127.0.0.1:18790/api/send-message \
  -H "Content-Type: application/json" \
  -d '{"to": "LID@lid", "text": "Imagens traduzidas para PT-BR 🇧🇷"}'

sleep 2

# Enviar cada imagem
for f in /Users/2a/.hermes/workspace/media/translated/ig_SHORTCODE_*_ptbr.png; do
  curl -s -X POST http://127.0.0.1:18790/api/send-image \
    -H "Content-Type: application/json" \
    -d "{\"to\": \"LID@lid\", \"file\": \"$f\"}"
  sleep 2
done
```

## Scripts necessários

- `/Users/2a/.hermes/workspace/scripts/download-instagram.py` — baixa carrossel via instaloader
- `/Users/2a/.hermes/workspace/scripts/translate-image.py` — traduz via Nano Banana Pro (Gemini 3 Pro Image)
- API key Gemini hardcoded no translate-image.py
