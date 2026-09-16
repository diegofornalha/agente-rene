#!/usr/bin/env python3
"""Copia recursiva server-side: STUDIO FISCAL -> Material Comercial/STUDIO FISCAL.
Usa o token OAuth do workspace-mcp (conta lucas@lucasjuridico.com), Drive API v3.
Idempotente: reusa pastas espelho existentes (por nome) e pula arquivos ja copiados
(nome+tamanho identicos no destino), contando-os como OK.
"""
import json, os, sys, time
import requests

CRED = "/home/hermes/.config/workspace-mcp/credentials/lucas@lucasjuridico.com.json"
SRC_ROOT = "11ON71jjdHG_rKZKeiIpwsCicvWhGZ_Vg"
DST_ROOT = "1oNBaQgXK9rsXGmaRKg_uBBclwdQNukTv"  # Material Comercial/STUDIO FISCAL (ja criada)
MANIFEST = "/home/hermes/agente-rene/work/gs_copy/fragments/studio-fiscal.md"
SUMMARY = "/home/hermes/agente-rene/work/gs_copy/studio-fiscal-summary.json"
API = "https://www.googleapis.com/drive/v3"
FOLDER_MT = "application/vnd.google-apps.folder"
SHORTCUT_MT = "application/vnd.google-apps.shortcut"

sess = requests.Session()
_token = {"value": None}

def refresh_token():
    c = json.load(open(CRED))
    r = requests.post(c["token_uri"], data={
        "client_id": c["client_id"], "client_secret": c["client_secret"],
        "refresh_token": c["refresh_token"], "grant_type": "refresh_token"})
    r.raise_for_status()
    _token["value"] = r.json()["access_token"]
    sess.headers["Authorization"] = "Bearer " + _token["value"]

def api(method, path, retries=5, **kw):
    for attempt in range(retries):
        r = sess.request(method, API + path, timeout=120, **kw)
        if r.status_code == 401:
            refresh_token(); continue
        if r.status_code in (403, 429, 500, 502, 503, 504):
            # 403 pode ser rate limit; se for outro 403, o retry só custa tempo
            time.sleep(2 ** attempt)
            continue
        return r
    return r

def list_children(folder_id):
    items, page_token = [], None
    while True:
        params = {
            "q": f"'{folder_id}' in parents and trashed=false",
            "fields": "nextPageToken,files(id,name,mimeType,size,modifiedTime)",
            "pageSize": 1000,
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        }
        if page_token:
            params["pageToken"] = page_token
        r = api("GET", "/files", params=params)
        r.raise_for_status()
        d = r.json()
        items.extend(d.get("files", []))
        page_token = d.get("nextPageToken")
        if not page_token:
            return items

stats = {"files_ok": 0, "folders_created": 0, "dups": 0, "shortcuts": 0, "errors": []}
mf = open(MANIFEST, "a", buffering=1)

def log(subpath, name, status):
    prefix = "Material Comercial/STUDIO FISCAL" + (("/" + subpath) if subpath else "")
    mf.write(f"- [{prefix}] {name} — {status}\n")

def dedup(children):
    """Retorna (itens_a_processar, lista_de_pulados) aplicando regra nome+tamanho."""
    groups = {}
    for it in children:
        if it["mimeType"] == FOLDER_MT:
            continue
        key = (it["name"], it.get("size"))
        groups.setdefault(key, []).append(it)
    skip_ids = set()
    for key, its in groups.items():
        if len(its) > 1:
            its.sort(key=lambda x: x.get("modifiedTime", ""), reverse=True)
            for loser in its[1:]:
                skip_ids.add(loser["id"])
    keep = [it for it in children if it["id"] not in skip_ids]
    skipped = [it for it in children if it["id"] in skip_ids]
    return keep, skipped

def process(src_id, dst_id, subpath):
    try:
        src_children = list_children(src_id)
    except Exception as e:
        stats["errors"].append(f"{subpath or '(raiz)'}: falha ao listar ({e})")
        log(subpath, "(listagem da pasta)", f"ERRO(list: {e})")
        return
    dst_children = list_children(dst_id)
    dst_folders = {c["name"]: c["id"] for c in dst_children if c["mimeType"] == FOLDER_MT}
    dst_files = {(c["name"], c.get("size")) for c in dst_children if c["mimeType"] != FOLDER_MT}

    keep, skipped = dedup(src_children)
    for it in skipped:
        stats["dups"] += 1
        log(subpath, it["name"], "PULADO(dup)")

    for it in keep:
        name, mt = it["name"], it["mimeType"]
        child_path = f"{subpath}/{name}" if subpath else name
        if mt == FOLDER_MT:
            if name in dst_folders:
                new_id = dst_folders[name]
            else:
                r = api("POST", "/files", params={"supportsAllDrives": "true"},
                        json={"name": name, "mimeType": FOLDER_MT, "parents": [dst_id]})
                if r.status_code != 200:
                    stats["errors"].append(f"{child_path}: criar pasta HTTP {r.status_code}")
                    log(subpath, name, f"ERRO(criar pasta: HTTP {r.status_code})")
                    continue
                new_id = r.json()["id"]
                stats["folders_created"] += 1
            process(it["id"], new_id, child_path)
        elif mt == SHORTCUT_MT:
            stats["shortcuts"] += 1
            log(subpath, name, "PULADO(atalho)")
        else:
            if (name, it.get("size")) in dst_files:
                stats["files_ok"] += 1  # ja copiado em rodada anterior
                log(subpath, name, "OK")
                continue
            r = api("POST", f"/files/{it['id']}/copy",
                    params={"supportsAllDrives": "true"},
                    json={"name": name, "parents": [dst_id]})
            if r.status_code == 200:
                stats["files_ok"] += 1
                log(subpath, name, "OK")
            else:
                try:
                    reason = r.json().get("error", {}).get("message", "")[:120]
                except Exception:
                    reason = ""
                stats["errors"].append(f"{child_path}: HTTP {r.status_code} {reason}")
                log(subpath, name, f"ERRO(HTTP {r.status_code} {reason})")

refresh_token()
process(SRC_ROOT, DST_ROOT, "")
mf.close()
json.dump(stats, open(SUMMARY, "w"), ensure_ascii=False, indent=1)
print(json.dumps(stats, ensure_ascii=False, indent=1))
