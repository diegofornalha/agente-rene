#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["instagrapi", "pillow", "python-dotenv"]
# ///
"""
CLI unificado para Instagram via instagrapi.
Conta: @meulucroativo (Lucro Ativo)

Uso: python3 instagram.py <comando> [opções]
"""
import sys
import os
from pathlib import Path
from PIL import Image
from dotenv import load_dotenv
from instagrapi import Client
from instagrapi.exceptions import LoginRequired

ENV_FILE = Path(__file__).parent.parent / ".env"  # backend-sdk-claude/.env (credenciais centralizadas)
SESSION_DIR = Path(__file__).parent.parent / "data" / "instagram-sessions"
SESSION_DIR.mkdir(parents=True, exist_ok=True)

load_dotenv(ENV_FILE)

ALL_ACCOUNTS = ["lucroativo"]


# ── Auth ──

def get_credentials(account):
    username = os.getenv(f"INSTAGRAM_ACCOUNT_{account}_USER")
    password = os.getenv(f"INSTAGRAM_ACCOUNT_{account}_PASS")
    if not username or not password:
        print(f"ERRO: credenciais não encontradas para '{account}'")
        sys.exit(1)
    return username, password


def get_client(account):
    username, password = get_credentials(account)
    session_file = SESSION_DIR / f"{account}.json"
    cl = Client()
    cl.delay_range = [1, 3]

    if session_file.exists():
        try:
            cl.load_settings(str(session_file))
            cl.login(username, password)
            cl.get_timeline_feed()
            return cl
        except (LoginRequired, Exception):
            session_file.unlink(missing_ok=True)

    cl.login(username, password)
    cl.dump_settings(str(session_file))
    return cl


def ensure_jpg(path):
    p = Path(path)
    if p.suffix.lower() == ".jpg":
        return p
    jpg_path = p.with_suffix(".jpg")
    Image.open(p).convert("RGB").save(jpg_path, "JPEG", quality=95)
    return jpg_path


def resolve_accounts(account_arg):
    if account_arg == "all":
        return ALL_ACCOUNTS
    return [account_arg]


# ── Conteúdo ──

def cmd_post(args):
    """Posta foto, carrossel ou mix foto+vídeo. Uso: post [--account X|all] <img1> [img2... | video.mp4] <legenda>"""
    account, args = extract_account(args)
    *images, caption = args
    if not images:
        print("ERRO: pelo menos 1 arquivo e 1 legenda são necessários")
        return

    for acc in resolve_accounts(account):
        cl = get_client(acc)
        # Preservar .mp4 como vídeo, converter o resto pra JPG
        paths = []
        for p in images[:10]:
            if Path(p).suffix.lower() == ".mp4":
                paths.append(Path(p))
            else:
                paths.append(ensure_jpg(p))
        if len(paths) == 1:
            if paths[0].suffix.lower() == ".mp4":
                media = cl.clip_upload(paths[0], caption)
            else:
                media = cl.photo_upload(paths[0], caption)
        else:
            media = cl.album_upload(paths, caption)
        print(f"OK @{acc}: https://instagram.com/p/{media.code}")


def cmd_story(args):
    """Posta story. Uso: story [--account X|all] <img1> [img2...]"""
    account, args = extract_account(args)
    if not args:
        print("ERRO: pelo menos 1 imagem necessária")
        return

    for acc in resolve_accounts(account):
        cl = get_client(acc)
        for img in args:
            p = ensure_jpg(img)
            media = cl.photo_upload_to_story(p)
            print(f"OK story @{acc}: id={media.pk}")


def cmd_reel(args):
    """Posta reel. Uso: reel [--account X|all] <video> <legenda>"""
    account, args = extract_account(args)
    if len(args) < 2:
        print("ERRO: video e legenda são necessários")
        return
    video, caption = args[0], args[1]

    for acc in resolve_accounts(account):
        cl = get_client(acc)
        media = cl.clip_upload(Path(video), caption)
        print(f"OK reel @{acc}: https://instagram.com/p/{media.code}")


def cmd_delete(args):
    """Deleta post. Uso: delete [--account X] <media_id|url>"""
    account, args = extract_account(args)
    if not args:
        print("ERRO: media_id ou url necessário")
        return

    for acc in resolve_accounts(account):
        cl = get_client(acc)
        media_id = args[0]
        if "instagram.com" in media_id:
            media_pk = cl.media_pk_from_url(media_id)
        else:
            media_pk = media_id
        cl.media_delete(media_pk)
        print(f"OK deletado @{acc}: {media_pk}")


def cmd_edit_caption(args):
    """Edita legenda. Uso: edit-caption [--account X] <media_id|url> <nova_legenda>"""
    account, args = extract_account(args)
    if len(args) < 2:
        print("ERRO: media_id e nova legenda necessários")
        return

    for acc in resolve_accounts(account):
        cl = get_client(acc)
        media_id = args[0]
        if "instagram.com" in media_id:
            media_pk = cl.media_pk_from_url(media_id)
        else:
            media_pk = media_id
        cl.media_edit(media_pk, args[1])
        print(f"OK legenda editada @{acc}: {media_pk}")


# ── Engajamento ──

def cmd_like(args):
    """Curte post. Uso: like [--account X|all] <media_id|url>"""
    account, args = extract_account(args)
    if not args:
        print("ERRO: media_id ou url necessário")
        return

    for acc in resolve_accounts(account):
        cl = get_client(acc)
        media_id = args[0]
        if "instagram.com" in media_id:
            media_pk = cl.media_pk_from_url(media_id)
        else:
            media_pk = media_id
        cl.media_like(media_pk)
        print(f"OK curtido @{acc}: {media_pk}")


def cmd_unlike(args):
    """Descurte post. Uso: unlike [--account X|all] <media_id|url>"""
    account, args = extract_account(args)
    if not args:
        return

    for acc in resolve_accounts(account):
        cl = get_client(acc)
        media_id = args[0]
        if "instagram.com" in media_id:
            media_pk = cl.media_pk_from_url(media_id)
        else:
            media_pk = media_id
        cl.media_unlike(media_pk)
        print(f"OK descurtido @{acc}: {media_pk}")


def cmd_comment(args):
    """Comenta em post. Uso: comment [--account X|all] <media_id|url> <texto>"""
    account, args = extract_account(args)
    if len(args) < 2:
        print("ERRO: media_id e texto necessários")
        return

    for acc in resolve_accounts(account):
        cl = get_client(acc)
        media_id = args[0]
        if "instagram.com" in media_id:
            media_pk = cl.media_pk_from_url(media_id)
        else:
            media_pk = media_id
        comment = cl.media_comment(media_pk, args[1])
        print(f"OK comentário @{acc}: {comment.pk}")


def cmd_follow(args):
    """Segue conta. Uso: follow [--account X|all] <username>"""
    account, args = extract_account(args)
    if not args:
        return

    for acc in resolve_accounts(account):
        cl = get_client(acc)
        user_id = cl.user_id_from_username(args[0])
        cl.user_follow(user_id)
        print(f"OK @{acc} seguiu @{args[0]}")


def cmd_unfollow(args):
    """Deixa de seguir. Uso: unfollow [--account X|all] <username>"""
    account, args = extract_account(args)
    if not args:
        return

    for acc in resolve_accounts(account):
        cl = get_client(acc)
        user_id = cl.user_id_from_username(args[0])
        cl.user_unfollow(user_id)
        print(f"OK @{acc} deixou de seguir @{args[0]}")


# ── Direct (DM) ──

def cmd_dm_send(args):
    """Envia DM. Uso: dm-send [--account X] <username> <texto>"""
    account, args = extract_account(args)
    if len(args) < 2:
        print("ERRO: username e texto necessários")
        return

    for acc in resolve_accounts(account):
        cl = get_client(acc)
        user_id = cl.user_id_from_username(args[0])
        cl.direct_send(args[1], [user_id])
        print(f"OK DM @{acc} → @{args[0]}")


def cmd_dm_send_photo(args):
    """Envia foto no DM. Uso: dm-send-photo [--account X] <username> <imagem>"""
    account, args = extract_account(args)
    if len(args) < 2:
        return

    for acc in resolve_accounts(account):
        cl = get_client(acc)
        user_id = cl.user_id_from_username(args[0])
        cl.direct_send_photo(Path(args[1]), [user_id])
        print(f"OK foto DM @{acc} → @{args[0]}")


def cmd_dm_inbox(args):
    """Lê inbox. Uso: dm-inbox [--account X] [--limit N]"""
    account, args = extract_account(args)
    limit = 10
    if "--limit" in args:
        idx = args.index("--limit")
        limit = int(args[idx + 1])
        args = args[:idx] + args[idx + 2:]

    for acc in resolve_accounts(account):
        cl = get_client(acc)
        try:
            threads = cl.direct_threads(limit)
        except Exception as e:
            print(f"=== Inbox @{acc} — erro ao ler: {e} ===")
            continue
        print(f"=== Inbox @{acc} ({len(threads)} conversas) ===")
        for t in threads:
            users = ", ".join([u.username for u in t.users])
            try:
                last = t.messages[0].text if t.messages and t.messages[0].text else "(mídia)"
            except Exception:
                last = "(mensagem não legível)"
            print(f"  {users}: {last[:80]}")


# ── Pesquisa ──

def cmd_search_user(args):
    """Busca usuário. Uso: search-user [--account X] <query>"""
    account, args = extract_account(args)
    if not args:
        return

    acc = resolve_accounts(account)[0]
    cl = get_client(acc)
    users = cl.search_users(args[0])
    for u in users[:10]:
        print(f"@{u.username} — {u.full_name}")


def cmd_search_hashtag(args):
    """Busca hashtag. Uso: search-hashtag [--account X] <tag> [--limit N]"""
    account, args = extract_account(args)
    limit = 10
    if "--limit" in args:
        idx = args.index("--limit")
        limit = int(args[idx + 1])
        args = args[:idx] + args[idx + 2:]
    if not args:
        return

    acc = resolve_accounts(account)[0]
    cl = get_client(acc)
    medias = cl.hashtag_medias_recent(args[0], limit)
    for m in medias:
        print(f"https://instagram.com/p/{m.code} — @{m.user.username} — {m.like_count} likes")


def cmd_followers(args):
    """Lista seguidores. Uso: followers [--account X] [username] [--limit N]"""
    account, args = extract_account(args)
    limit = 50
    if "--limit" in args:
        idx = args.index("--limit")
        limit = int(args[idx + 1])
        args = args[:idx] + args[idx + 2:]

    acc = resolve_accounts(account)[0]
    cl = get_client(acc)
    if args:
        user_id = cl.user_id_from_username(args[0])
    else:
        user_id = cl.user_id
    followers = cl.user_followers(user_id, amount=limit)
    print(f"Seguidores ({len(followers)}):")
    for uid, info in followers.items():
        print(f"  @{info.username} — {info.full_name}")


def cmd_following(args):
    """Lista quem segue. Uso: following [--account X] [username] [--limit N]"""
    account, args = extract_account(args)
    limit = 50
    if "--limit" in args:
        idx = args.index("--limit")
        limit = int(args[idx + 1])
        args = args[:idx] + args[idx + 2:]

    acc = resolve_accounts(account)[0]
    cl = get_client(acc)
    if args:
        user_id = cl.user_id_from_username(args[0])
    else:
        user_id = cl.user_id
    following = cl.user_following(user_id, amount=limit)
    print(f"Seguindo ({len(following)}):")
    for uid, info in following.items():
        print(f"  @{info.username} — {info.full_name}")


def cmd_user_posts(args):
    """Posts de um perfil. Uso: user-posts [--account X] <username> [--limit N]"""
    account, args = extract_account(args)
    limit = 10
    if "--limit" in args:
        idx = args.index("--limit")
        limit = int(args[idx + 1])
        args = args[:idx] + args[idx + 2:]

    if not args:
        return

    acc = resolve_accounts(account)[0]
    cl = get_client(acc)
    user_id = cl.user_id_from_username(args[0])
    medias = cl.user_medias(user_id, limit)
    for m in medias:
        print(f"https://instagram.com/p/{m.code} — {m.like_count} likes — {(m.caption_text or '')[:60]}")


# ── Insights ──

def cmd_info(args):
    """Info de conta. Uso: info [--account X] [username]"""
    account, args = extract_account(args)

    acc = resolve_accounts(account)[0]
    cl = get_client(acc)
    if args:
        user = cl.user_info_by_username(args[0])
    else:
        user = cl.user_info(cl.user_id)

    print(f"@{user.username}")
    print(f"Nome: {user.full_name}")
    print(f"Bio: {user.biography}")
    print(f"Seguidores: {user.follower_count}")
    print(f"Seguindo: {user.following_count}")
    print(f"Posts: {user.media_count}")
    print(f"Verificado: {user.is_verified}")


def cmd_media_info(args):
    """Info de post. Uso: media-info [--account X] <url>"""
    account, args = extract_account(args)
    if not args:
        return

    acc = resolve_accounts(account)[0]
    cl = get_client(acc)
    media_pk = cl.media_pk_from_url(args[0])
    m = cl.media_info(media_pk)
    print(f"URL: https://instagram.com/p/{m.code}")
    print(f"Autor: @{m.user.username}")
    print(f"Tipo: {m.media_type}")
    print(f"Likes: {m.like_count}")
    print(f"Comentários: {m.comment_count}")
    print(f"Legenda: {(m.caption_text or '')[:200]}")


# ── Helpers ──

def extract_account(args):
    account = "lucroativo"
    if "--account" in args:
        idx = args.index("--account")
        account = args[idx + 1]
        args = args[:idx] + args[idx + 2:]
    return account, args


COMMANDS = {
    # Conteúdo
    "post": cmd_post,
    "story": cmd_story,
    "reel": cmd_reel,
    "delete": cmd_delete,
    "edit-caption": cmd_edit_caption,
    # Engajamento
    "like": cmd_like,
    "unlike": cmd_unlike,
    "comment": cmd_comment,
    "follow": cmd_follow,
    "unfollow": cmd_unfollow,
    # DM
    "dm-send": cmd_dm_send,
    "dm-send-photo": cmd_dm_send_photo,
    "dm-inbox": cmd_dm_inbox,
    # Pesquisa
    "search-user": cmd_search_user,
    "search-hashtag": cmd_search_hashtag,
    "followers": cmd_followers,
    "following": cmd_following,
    "user-posts": cmd_user_posts,
    # Insights
    "info": cmd_info,
    "media-info": cmd_media_info,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        print("Instagram CLI — Comandos disponíveis:\n")
        for name, fn in COMMANDS.items():
            print(f"  {name:20s} {fn.__doc__.split('.')[0] if fn.__doc__ else ''}")
        print(f"\nOpção global: --account <nome|all>  (default: lucroativo)")
        sys.exit(0)

    cmd = sys.argv[1]
    if cmd not in COMMANDS:
        print(f"ERRO: comando '{cmd}' não encontrado. Use 'help' pra listar.")
        sys.exit(1)

    COMMANDS[cmd](sys.argv[2:])
