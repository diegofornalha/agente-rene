#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["instagrapi", "python-dotenv"]
# ///
"""
Login interativo para resolver challenge do Instagram e salvar sessão.

Uso: python3 login-interactive.py <conta> [--code XXXXXX]
Exemplo: python3 login-interactive.py lucroativo
         python3 login-interactive.py lucroativo --code 123456

Sem --code, pede o código via input() (uso em terminal de verdade). Com
--code, usa o valor direto — necessário quando chamado via subprocess (sem
TTY interativo pra responder o input()).
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
    TwoFactorRequired,
)

ENV_FILE = Path(__file__).parent.parent / ".env"  # backend-sdk-claude/.env (credenciais centralizadas)
SESSION_DIR = Path(__file__).parent.parent / "data" / "instagram-sessions"
SESSION_DIR.mkdir(parents=True, exist_ok=True)

load_dotenv(ENV_FILE)

_PRESET_CODE = None


def challenge_code_handler(username, choice):
    if _PRESET_CODE:
        print(f"\n>>> Instagram pediu verificação para @{username} — usando --code fornecido")
        return _PRESET_CODE
    print(f"\n>>> Instagram pediu verificação para @{username}")
    print(f">>> Método: {choice}")
    code = input(">>> Digite o código de 6 dígitos recebido: ").strip()
    return code


def change_password_handler(username):
    print(f"\n>>> Instagram exigindo troca de senha para @{username}")
    print(">>> Faça isso pelo app/web e rode de novo.")
    sys.exit(1)


def main():
    global _PRESET_CODE

    if len(sys.argv) < 2:
        print("Uso: python3 login-interactive.py <conta> [--code XXXXXX]")
        print("Contas disponíveis: lucroativo")
        sys.exit(1)

    account = sys.argv[1]
    if "--code" in sys.argv:
        idx = sys.argv.index("--code")
        _PRESET_CODE = sys.argv[idx + 1]

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
    except TwoFactorRequired:
        print(f"\n>>> Instagram pediu verificação em duas etapas (2FA) para @{username}")
        code = _PRESET_CODE or input(">>> Digite o código de 6 dígitos (SMS/app autenticador): ").strip()
        try:
            cl.login(username, password, verification_code=code)
        except Exception as err:
            print(f"\nFalha no login com 2FA: {err}")
            sys.exit(1)
    except ChallengeRequired:
        print(f"\nChallenge obrigatório. Tentando resolver...")
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
        print("Logue pelo navegador uma vez e rode aqui de novo.")
        sys.exit(1)
    except Exception as e:
        print(f"\nErro inesperado: {e}")
        sys.exit(1)

    cl.dump_settings(str(session_file))
    print(f"\nOK sessão salva em: {session_file}")
    print(f"Verificando feed para validar...")
    try:
        cl.get_timeline_feed()
        print("OK feed acessado — sessão funciona.")
    except Exception as e:
        print(f"AVISO: sessão salva mas feed falhou: {e}")


if __name__ == "__main__":
    main()
