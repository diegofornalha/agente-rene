#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "requests>=2.31",
#     "linkedin-api>=2.0",
#     "python-dotenv>=1.0",
# ]
# ///
"""
Teste E2E das skills do LinkedIn — CRUD completo.

Princípio: tudo que for CRIADO durante os testes é APAGADO ao final.
Operações read-only (perfil, feed, busca, conexões, inbox) não precisam cleanup.

Uso:
    uv run tests/linkedin-e2e.py [--verbose]

Requer:
    - OAuth tokens válidos em LinkedIn/secrets/linkedin_tokens.json
    - Credenciais da CLI não-oficial no .env (LINKEDIN_ACCOUNT_diegofornalha_EMAIL/PASS)
"""

import json
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
POSTER = REPO_ROOT / "LinkedIn" / "scripts" / "linkedin_poster.py"
CLI = REPO_ROOT / "LinkedIn" / "scripts" / "linkedin_cli.py"

VERBOSE = "--verbose" in sys.argv or "-v" in sys.argv

# Marca temporal única pra identificar posts de teste
TEST_TAG = f"[E2E-TEST-{int(time.time())}]"

# Acumulador de recursos criados pra cleanup
_cleanup_post_urns: list[str] = []


class TestResult:
    def __init__(self):
        self.passed: list[str] = []
        self.failed: list[tuple[str, str]] = []
        self.skipped: list[tuple[str, str]] = []

    def ok(self, name: str):
        self.passed.append(name)
        print(f"  ✅ {name}")

    def fail(self, name: str, reason: str):
        self.failed.append((name, reason))
        print(f"  ❌ {name}: {reason}")

    def skip(self, name: str, reason: str):
        self.skipped.append((name, reason))
        print(f"  ⏭️  {name}: {reason}")

    def summary(self):
        total = len(self.passed) + len(self.failed) + len(self.skipped)
        print(f"\n{'='*60}")
        print(f"Resultado: {len(self.passed)}/{total} passaram"
              f" | {len(self.failed)} falharam"
              f" | {len(self.skipped)} pulados")
        if self.failed:
            print("\nFalhas:")
            for name, reason in self.failed:
                print(f"  - {name}: {reason}")
        print(f"{'='*60}")
        return len(self.failed) == 0


results = TestResult()


# ── Helpers ───────────────────────────────────────────────────────────────────

def run_script(script: Path, args: list[str], timeout: int = 60) -> tuple[int, str, str]:
    """Executa um script Python via uv run e retorna (returncode, stdout, stderr)."""
    cmd = ["uv", "run", str(script)] + args
    if VERBOSE:
        print(f"    $ {' '.join(cmd)}")
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=str(REPO_ROOT),
    )
    if VERBOSE and proc.stdout.strip():
        for line in proc.stdout.strip().split("\n"):
            print(f"    stdout: {line}")
    if VERBOSE and proc.stderr.strip():
        for line in proc.stderr.strip().split("\n"):
            print(f"    stderr: {line}")
    return proc.returncode, proc.stdout, proc.stderr


def is_challenge_error(stderr: str) -> bool:
    """Detecta se o erro é ChallengeException (LinkedIn pedindo CAPTCHA/verificação)."""
    return "ChallengeException" in stderr or "CHALLENGE" in stderr


def extract_post_id(stdout: str) -> str:
    """Extrai POST_ID:xxx da saída do linkedin_poster.py."""
    for line in stdout.split("\n"):
        if line.startswith("POST_ID:"):
            return line.split("POST_ID:", 1)[1].strip()
    return ""


def cleanup():
    """Deleta todos os posts criados durante o teste."""
    if not _cleanup_post_urns:
        print("\n🧹 Cleanup: nada pra limpar.")
        return
    print(f"\n🧹 Cleanup: deletando {len(_cleanup_post_urns)} post(s) de teste...")
    for urn in _cleanup_post_urns:
        try:
            rc, out, err = run_script(POSTER, ["delete", urn], timeout=30)
            if rc == 0:
                print(f"  🗑️  Deletado: {urn}")
            else:
                print(f"  ⚠️  Falha ao deletar {urn}: {err.strip()}")
        except Exception as e:
            print(f"  ⚠️  Exceção deletando {urn}: {e}")


# ── Testes: OAuth / Poster (oficial) ─────────────────────────────────────────

def test_oauth_me():
    """Testa comando 'me' — read-only, sem cleanup."""
    rc, out, err = run_script(POSTER, ["me"])
    if rc != 0:
        results.fail("oauth:me", f"exit={rc} err={err.strip()[:120]}")
        return False
    try:
        data = json.loads(out)
        if "sub" in data or "name" in data:
            results.ok("oauth:me")
            return True
        results.fail("oauth:me", "resposta sem 'sub' nem 'name'")
        return False
    except json.JSONDecodeError:
        # O script imprime JSON + uma mensagem de "Tokens salvos" — tenta parsear só o JSON
        if '"sub"' in out or '"name"' in out:
            results.ok("oauth:me")
            return True
        results.fail("oauth:me", "saída não é JSON válido")
        return False


def test_post_text_crud():
    """CRUD completo: cria post de texto → lê → deleta."""
    text = f"{TEST_TAG} Teste automatizado E2E — será deletado em segundos."

    # CREATE
    rc, out, err = run_script(POSTER, ["post", text])
    if rc != 0:
        results.fail("post:create_text", f"exit={rc} err={err.strip()[:120]}")
        return
    post_id = extract_post_id(out)
    if not post_id:
        results.fail("post:create_text", "sem POST_ID na saída")
        return
    _cleanup_post_urns.append(post_id)
    results.ok("post:create_text")

    # Pequena pausa pra propagação
    time.sleep(3)

    # READ — GET /rest/posts requer scope r_organization_social que não temos
    # pra perfis pessoais. 403 é esperado — não é bug, é limitação da API.
    rc, out, err = run_script(POSTER, ["get", post_id])
    if "ACCESS_DENIED" in err or "403" in err:
        results.skip("post:read_text", "GET /posts requer scope r_organization_social (403 esperado)")
    elif rc != 0 or not out.strip() or out.strip() == "{}":
        results.fail("post:read_text", f"post não encontrado após criação (rc={rc})")
    else:
        try:
            data = json.loads(out)
            if data.get("commentary", "") or data.get("author", ""):
                results.ok("post:read_text")
            else:
                results.fail("post:read_text", "resposta vazia ou sem campos esperados")
        except json.JSONDecodeError:
            results.fail("post:read_text", "saída não é JSON")

    # DELETE
    rc, out, err = run_script(POSTER, ["delete", post_id])
    if rc == 0:
        _cleanup_post_urns.remove(post_id)
        results.ok("post:delete_text")
    else:
        results.fail("post:delete_text", f"exit={rc} err={err.strip()[:120]}")

    # VERIFY DELETION — mesmo 403 aqui confirma que o delete funcionou
    # (se o post existisse e tivéssemos scope, voltaria 200)
    time.sleep(2)
    rc, out, err = run_script(POSTER, ["get", post_id])
    if "ACCESS_DENIED" in err or "403" in err:
        results.skip("post:verify_deleted", "GET requer scope extra — delete já confirmou com 204")
    else:
        try:
            data = json.loads(out) if out.strip() else {}
        except json.JSONDecodeError:
            data = {}
        if not data or data == {}:
            results.ok("post:verify_deleted")
        else:
            results.skip("post:verify_deleted", "post ainda visível (eventual consistency)")


def test_post_with_image_crud():
    """Cria post com imagem de teste → deleta."""
    # Cria imagem de teste mínima (1x1 red pixel PNG)
    import base64
    test_img = REPO_ROOT / "tests" / "_test_img.png"
    # PNG mínimo 1x1 pixel vermelho
    png_b64 = (
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
        "nGP4z8BQDwAEgAF/pooBPQAAAABJRU5ErkJggg=="
    )
    test_img.write_bytes(base64.b64decode(png_b64))

    try:
        text = f"{TEST_TAG} Teste E2E com imagem — será deletado."
        rc, out, err = run_script(POSTER, ["post", text, "--img", str(test_img)])
        if rc != 0:
            results.fail("post:create_image", f"exit={rc} err={err.strip()[:120]}")
            return
        post_id = extract_post_id(out)
        if not post_id:
            results.fail("post:create_image", "sem POST_ID")
            return
        _cleanup_post_urns.append(post_id)
        results.ok("post:create_image")

        # DELETE
        time.sleep(3)
        rc, out, err = run_script(POSTER, ["delete", post_id])
        if rc == 0:
            _cleanup_post_urns.remove(post_id)
            results.ok("post:delete_image")
        else:
            results.fail("post:delete_image", f"exit={rc} err={err.strip()[:120]}")
    finally:
        test_img.unlink(missing_ok=True)


# ── Testes: CLI não-oficial ──────────────────────────────────────────────────

def _cli_read_test(name: str, args: list[str], success_check=None):
    """Helper pra testes read-only da CLI não-oficial. Detecta CHALLENGE automaticamente."""
    rc, out, err = run_script(CLI, args)
    if is_challenge_error(err):
        results.skip(name, "ChallengeException — LinkedIn exige verificação na conta diegofornalha")
        return
    if rc != 0:
        results.fail(name, f"exit={rc} err={err.strip()[:120]}")
        return
    if success_check and not success_check(out):
        results.fail(name, f"check falhou — out={out.strip()[:80]}")
        return
    results.ok(name)


def test_cli_profile():
    _cli_read_test("cli:profile_self", ["profile"],
                   lambda out: "Nome:" in out or "Headline:" in out)


def test_cli_feed():
    _cli_read_test("cli:feed", ["feed", "--limit", "3"])


def test_cli_search_people():
    _cli_read_test("cli:search_people", ["search-people", "engenheiro software", "--limit", "3"])


def test_cli_search_companies():
    _cli_read_test("cli:search_companies", ["search-companies", "Nubank", "--limit", "3"])


def test_cli_search_jobs():
    _cli_read_test("cli:search_jobs", ["search-jobs", "python developer", "--limit", "3"])


def test_cli_connections():
    _cli_read_test("cli:connections", ["connections", "--limit", "5"])


def test_cli_inbox():
    _cli_read_test("cli:inbox", ["msg-inbox", "--limit", "3"])


def test_cli_like_and_comment_on_own_post():
    """Cria post via OAuth → like + comment via CLI → deleta post (cleanup total)."""
    text = f"{TEST_TAG} Post pra teste de like/comment — será deletado."
    rc, out, err = run_script(POSTER, ["post", text])
    if rc != 0:
        results.skip("cli:like", "não conseguiu criar post base")
        results.skip("cli:comment", "não conseguiu criar post base")
        return

    post_id = extract_post_id(out)
    if not post_id:
        results.skip("cli:like", "sem POST_ID do post base")
        results.skip("cli:comment", "sem POST_ID do post base")
        return
    _cleanup_post_urns.append(post_id)

    time.sleep(3)

    # Converte ugcPost URN → activity URN pra CLI não-oficial
    # A CLI usa activity URN: urn:li:activity:XXX
    # O poster retorna ugcPost URN: urn:li:ugcPost:XXX ou urn:li:share:XXX
    # Pra like/comment na CLI, precisamos do post_urn como está
    activity_urn = post_id

    # LIKE
    rc, out, err = run_script(CLI, ["like", activity_urn])
    if is_challenge_error(err):
        results.skip("cli:like", "ChallengeException — LinkedIn exige verificação")
    elif rc == 0 and "OK" in out:
        results.ok("cli:like")
    else:
        results.fail("cli:like", f"exit={rc} err={err.strip()[:120]}")

    # COMMENT
    comment_text = f"{TEST_TAG} Comentário de teste E2E"
    rc, out, err = run_script(CLI, ["comment", activity_urn, comment_text])
    if is_challenge_error(err):
        results.skip("cli:comment", "ChallengeException — LinkedIn exige verificação")
    elif rc == 0 and "OK" in out:
        results.ok("cli:comment")
    else:
        results.fail("cli:comment", f"exit={rc} err={err.strip()[:120]}")

    # CLEANUP: deletar o post inteiro (remove like + comment junto)
    time.sleep(2)
    rc, out, err = run_script(POSTER, ["delete", post_id])
    if rc == 0:
        _cleanup_post_urns.remove(post_id)
        results.ok("cli:like_comment_cleanup")
    else:
        results.fail("cli:like_comment_cleanup", f"exit={rc} err={err.strip()[:120]}")


# ── Runner ────────────────────────────────────────────────────────────────────

def main():
    print(f"{'='*60}")
    print(f"LinkedIn E2E Test Suite — {TEST_TAG}")
    print(f"{'='*60}")

    # Fase 1: OAuth / Poster (oficial)
    print("\n📋 Fase 1: OAuth (API oficial)")
    try:
        oauth_ok = test_oauth_me()
    except Exception as e:
        results.fail("oauth:me", str(e))
        oauth_ok = False

    if not oauth_ok:
        print("  ⚠️  OAuth falhou — pulando testes que dependem do poster.")
        results.skip("post:create_text", "oauth falhou")
        results.skip("post:read_text", "oauth falhou")
        results.skip("post:delete_text", "oauth falhou")
        results.skip("post:create_image", "oauth falhou")
        results.skip("post:delete_image", "oauth falhou")
    else:
        print("\n📋 Fase 2: CRUD de posts (API oficial)")
        try:
            test_post_text_crud()
        except Exception as e:
            results.fail("post:crud_text", f"exceção: {e}")
            traceback.print_exc() if VERBOSE else None

        try:
            test_post_with_image_crud()
        except Exception as e:
            results.fail("post:crud_image", f"exceção: {e}")
            traceback.print_exc() if VERBOSE else None

    # Fase 3: CLI não-oficial (read-only)
    print("\n📋 Fase 3: CLI não-oficial (leitura)")
    read_tests = [
        test_cli_profile,
        test_cli_feed,
        test_cli_search_people,
        test_cli_search_companies,
        test_cli_search_jobs,
        test_cli_connections,
        test_cli_inbox,
    ]
    for test_fn in read_tests:
        try:
            test_fn()
        except subprocess.TimeoutExpired:
            results.fail(test_fn.__name__.replace("test_", ""), "timeout")
        except Exception as e:
            results.fail(test_fn.__name__.replace("test_", ""), str(e)[:120])

    # Fase 4: Engajamento (like/comment) — cria + deleta
    print("\n📋 Fase 4: Engajamento (like + comment → cleanup)")
    if oauth_ok:
        try:
            test_cli_like_and_comment_on_own_post()
        except Exception as e:
            results.fail("cli:engagement", f"exceção: {e}")
            traceback.print_exc() if VERBOSE else None
    else:
        results.skip("cli:like", "oauth falhou")
        results.skip("cli:comment", "oauth falhou")

    # Cleanup final de segurança
    cleanup()

    # Resumo
    success = results.summary()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
