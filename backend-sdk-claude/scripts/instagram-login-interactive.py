#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["instagrapi", "python-dotenv"]
# ///
"""Login interativo pro Instagram — resolve challenge/2FA e salva a sessão.

Credenciais vêm do .env como INSTAGRAM_ACCOUNT_<conta>_USER / _PASS (mesma
convenção usada em scripts/instagram-post.py). Sessão salva em
data/instagram-sessions/<conta>.json — depois disso, instagram-post.py
reaproveita sem pedir login de novo.

Uso:
  uv run scripts/instagram-login-interactive.py <conta>
  uv run scripts/instagram-login-interactive.py lucroativo
  uv run scripts/instagram-login-interactive.py drlucasdossantos

⚠️ Se cair em RecaptchaChallengeForm, não dá pra resolver por aqui — precisa
logar uma vez pelo navegador (ex.: Chrome real na sessão VNC, ver
VNC-SETUP-GUIDE.md) e rodar este script de novo depois.
"""

import sys
import os
from pathlib import Path
from dotenv import load_dotenv
from instagrapi import Client
from instagrapi.exceptions import (
    ChallengeRequired,
    SelectContactPointRecoveryForm,
    RecaptchaChallengeForm,
)

BASE_DIR = Path(__file__).resolve().parent.parent  # backend-sdk-claude/
ENV_FILE = BASE_DIR / ".env"
SESSION_DIR = BASE_DIR / "data" / "instagram-sessions"
SESSION_DIR.mkdir(parents=True, exist_ok=True)

load_dotenv(ENV_FILE)


def challenge_code_handler(username, choice):
    print(f"\n>>> Instagram pediu verificação para @{username}")
    print(f">>> Método: {choice}")
    code = input(">>> Digite o código de 6 dígitos recebido: ").strip()
    return code


def change_password_handler(username):
    print(f"\n>>> Instagram exigindo troca de senha para @{username}")
    print(">>> Faça isso pelo app/web e rode de novo.")
    sys.exit(1)


def main():
    if len(sys.argv) < 2:
        print("Uso: uv run scripts/instagram-login-interactive.py <conta>")
        sys.exit(1)

    account = sys.argv[1]
    username = os.getenv(f"INSTAGRAM_ACCOUNT_{account}_USER")
    password = os.getenv(f"INSTAGRAM_ACCOUNT_{account}_PASS")

    if not username or not password:
        print(f"ERRO: credenciais não encontradas no .env para '{account}'")
        print(f"Esperado: INSTAGRAM_ACCOUNT_{account}_USER e INSTAGRAM_ACCOUNT_{account}_PASS")
        sys.exit(1)

    session_file = SESSION_DIR / f"{account}.json"

    cl = Client()
    cl.delay_range = [1, 3]
    cl.challenge_code_handler = challenge_code_handler
    cl.change_password_handler = change_password_handler

    print(f"Tentando login em @{username}...")
    try:
        cl.login(username, password)
    except ChallengeRequired:
        print("\nChallenge obrigatório. Tentando resolver...")
        try:
            cl.challenge_resolve(cl.last_json)
        except Exception as err:
            print(f"\nFalha ao resolver challenge: {err}")
            print("\n>>> SOLUÇÃO MANUAL:")
            print(f"1. Abra o Instagram no celular logado em @{username}")
            print("2. Aceite a notificação de login (ou veja o email)")
            print("3. Aguarde 2-5 minutos e rode este script de novo")
            sys.exit(1)
    except SelectContactPointRecoveryForm:
        print("\nInstagram pedindo escolher email/SMS para recuperação.")
        print("Resolva pelo app oficial primeiro.")
        sys.exit(1)
    except RecaptchaChallengeForm:
        print("\nReCAPTCHA exigido. Não dá pra resolver via script.")
        print("Logue pelo navegador uma vez (ver VNC-SETUP-GUIDE.md) e rode aqui de novo.")
        sys.exit(1)
    except Exception as e:
        print(f"\nErro inesperado: {e}")
        sys.exit(1)

    cl.dump_settings(str(session_file))
    print(f"\nOK sessão salva em: {session_file}")
    print("Verificando feed para validar...")
    try:
        cl.get_timeline_feed()
        print("OK feed acessado — sessão funciona.")
    except Exception as e:
        print(f"AVISO: sessão salva mas feed falhou: {e}")


if __name__ == "__main__":
    main()
