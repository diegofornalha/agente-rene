#!/usr/bin/env python3
"""Copia recursivamente o acervo 'GS - Materiais Sócios e Parceiros' (pasta
compartilhada do Grupo Studio) para o My Drive do Lucas, numa estrutura
organizada por temas. Cópia server-side (files.copy) — nada é baixado.

Re-executável: pastas/arquivos já existentes no destino são pulados.
"""
import json, time, urllib.request, urllib.parse, urllib.error, sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

CRED_PATH = "/home/hermes/.config/workspace-mcp/credentials/lucas@lucasjuridico.com.json"
SRC_ROOT = "194ufSGMJ37k03JXAC53TB92EOn16TRG2"  # GS - Materiais Sócios e Parceiros
DEST_ROOT_NAME = "Grupo Studio — Base de Conhecimento"

# agrupamento temático das 17 subpastas de topo
GROUPS = {
    "01 · Marca & Identidade": ["Identidade Visual", "Logos Grupo Studio", "Assinatura de Email", "Capas LinkedIn", "Fundo Vídeo Chamada"],
    "02 · Comercial & Apresentações": ["7 - MATERIAL COMERCIAL", "Apresentações", "Diagnósticos", "Cases de Sucesso  Ofertas", "Revista GS e Ofertas", "Midia Kit Online", "Midia Kit Impresso"],
    "03 · Conhecimento & Capacitação": ["Trilha Educacional", "Livro de Atestados"],
    "04 · Marketing & Redes Sociais": ["Manual de Marketing - Grupo Studio", "Redes Sociais"],
    "05 · Onboarding": ["Onboarding"],
}

creds = json.load(open(CRED_PATH))
TOKEN = creds["token"]
tok_lock = Lock()

def refresh_token():
    global TOKEN
    data = urllib.parse.urlencode({
        "client_id": creds["client_id"], "client_secret": creds["client_secret"],
        "refresh_token": creds["refresh_token"], "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request(creds["token_uri"], data=data)
    with urllib.request.urlopen(req) as r:
        TOKEN = json.load(r)["access_token"]

def api(method, path, params=None, body=None, retry=4):
    url = "https://www.googleapis.com/drive/v3/" + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    for attempt in range(retry):
        req = urllib.request.Request(url, method=method)
        req.add_header("Authorization", "Bearer " + TOKEN)
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, data) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            code = e.code
            if code == 401:
                with tok_lock:
                    refresh_token()
                continue
            if code in (403, 429, 500, 502, 503) and attempt < retry - 1:
                time.sleep(2 ** attempt + 1)
                continue
            err_body = e.read().decode(errors="replace")[:300]
            raise RuntimeError(f"HTTP {code} {path}: {err_body}")
    raise RuntimeError("retries exhausted: " + path)

def list_children(folder_id):
    items, token = [], None
    while True:
        params = {
            "q": f"'{folder_id}' in parents and trashed=false",
            "fields": "nextPageToken,files(id,name,mimeType,size,shortcutDetails)",
            "pageSize": 1000, "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        }
        if token:
            params["pageToken"] = token
        r = api("GET", "files", params)
        items += r.get("files", [])
        token = r.get("nextPageToken")
        if not token:
            return items

def ensure_folder(name, parent_id, cache={}):
    key = (parent_id, name)
    if key in cache:
        return cache[key]
    q = f"'{parent_id}' in parents and name = '{name.replace(chr(39), chr(92)+chr(39))}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    r = api("GET", "files", {"q": q, "fields": "files(id)", "pageSize": 1})
    if r.get("files"):
        fid = r["files"][0]["id"]
    else:
        fid = api("POST", "files", {"supportsAllDrives": "true"},
                  {"name": name, "mimeType": "application/vnd.google-apps.folder", "parents": [parent_id]})["id"]
    cache[key] = fid
    return fid

stats = {"copied": 0, "skipped": 0, "failed": [], "bytes": 0, "folders": 0}
st_lock = Lock()

def copy_file(f, dest_id, existing_names):
    name, mt = f["name"], f["mimeType"]
    if mt == "application/vnd.google-apps.shortcut":
        tgt = f.get("shortcutDetails", {})
        f = {"id": tgt.get("targetId"), "name": name, "mimeType": tgt.get("targetMimeType", ""), "size": 0}
        if not f["id"]:
            with st_lock:
                stats["failed"].append((name, "atalho sem alvo"))
            return
        if f["mimeType"] == "application/vnd.google-apps.folder":
            with st_lock:
                stats["failed"].append((name, "atalho para pasta — pulado"))
            return
    if name in existing_names:
        with st_lock:
            stats["skipped"] += 1
        return
    try:
        api("POST", f"files/{f['id']}/copy", {"supportsAllDrives": "true"}, {"name": name, "parents": [dest_id]})
        with st_lock:
            stats["copied"] += 1
            stats["bytes"] += int(f.get("size") or 0)
    except Exception as e:
        with st_lock:
            stats["failed"].append((name, str(e)[:160]))

def mirror(src_id, dest_id, pool, futures, path=""):
    children = list_children(src_id)
    dest_children = list_children(dest_id)
    existing = {c["name"] for c in dest_children if c["mimeType"] != "application/vnd.google-apps.folder"}
    for c in children:
        if c["mimeType"] == "application/vnd.google-apps.folder":
            sub = ensure_folder(c["name"], dest_id)
            with st_lock:
                stats["folders"] += 1
            mirror(c["id"], sub, pool, futures, path + "/" + c["name"])
        else:
            futures.append(pool.submit(copy_file, c, dest_id, existing))

def main():
    refresh_token()
    dest_root = ensure_folder(DEST_ROOT_NAME, "root")
    print("Pasta destino:", dest_root, flush=True)
    top = {c["name"]: c for c in list_children(SRC_ROOT)}
    grouped = set()
    futures = []
    with ThreadPoolExecutor(max_workers=6) as pool:
        for group, names in GROUPS.items():
            gid = ensure_folder(group, dest_root)
            for n in names:
                if n in top:
                    grouped.add(n)
                    sub = ensure_folder(top[n]["name"], gid)
                    mirror(top[n]["id"], sub, pool, futures)
        # qualquer pasta/arquivo de topo fora do agrupamento vai para "99 · Outros"
        leftovers = [c for n, c in top.items() if n not in grouped]
        if leftovers:
            oid = ensure_folder("99 · Outros", dest_root)
            for c in leftovers:
                if c["mimeType"] == "application/vnd.google-apps.folder":
                    sub = ensure_folder(c["name"], oid)
                    mirror(c["id"], sub, pool, futures)
                else:
                    futures.append(pool.submit(copy_file, c, oid, set()))
        done = 0
        for fu in as_completed(futures):
            done += 1
            if done % 25 == 0:
                print(f"progresso: {done}/{len(futures)}", flush=True)
    print(json.dumps({"dest_root": dest_root, "total_files": len(futures),
                      "copiados": stats["copied"], "pulados": stats["skipped"],
                      "pastas": stats["folders"], "mb": round(stats["bytes"]/1e6, 1),
                      "falhas": stats["failed"]}, ensure_ascii=False, indent=1))

if __name__ == "__main__":
    main()
