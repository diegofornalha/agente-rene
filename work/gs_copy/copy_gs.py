#!/usr/bin/env python3
"""Copia a pasta compartilhada 'GS - Materiais Sócios e Parceiros' para o My Drive
do Lucas, com dedup por checksum e reorganização temática das 17 subpastas.
Cópia 100% server-side (files.copy) — nada é baixado."""
import json, time, sys, unicodedata, urllib.request, urllib.parse, urllib.error

CRED = '/home/hermes/.config/workspace-mcp/credentials/lucas@lucasjuridico.com.json'
SRC_ROOT = '194ufSGMJ37k03JXAC53TB92EOn16TRG2'
DEST_NAME = 'Grupo Studio — Materiais (Referência)'
LOG = '/home/hermes/agente-rene/work/gs_copy/log.txt'
OUT = '/home/hermes/agente-rene/work/gs_copy/result.json'

def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG, 'a') as f:
        f.write(line + '\n')

# ---------- auth ----------
def get_token():
    d = json.load(open(CRED))
    body = urllib.parse.urlencode({
        'client_id': d['client_id'], 'client_secret': d['client_secret'],
        'refresh_token': d['refresh_token'], 'grant_type': 'refresh_token'}).encode()
    req = urllib.request.Request(d['token_uri'], data=body,
        headers={'Content-Type': 'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)['access_token']

TOKEN = get_token()

def api(method, path, params=None, body=None, raw_body=None, headers=None, retries=5):
    url = 'https://www.googleapis.com/drive/v3/' + path
    if params:
        url += '?' + urllib.parse.urlencode(params)
    hdrs = {'Authorization': f'Bearer {TOKEN}'}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        hdrs['Content-Type'] = 'application/json'
    if raw_body is not None:
        data = raw_body
    if headers:
        hdrs.update(headers)
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                txt = r.read()
                return json.loads(txt) if txt else {}
        except urllib.error.HTTPError as e:
            code = e.code
            detail = e.read().decode()[:300]
            if code in (403, 429, 500, 502, 503) and attempt < retries - 1:
                wait = 2 ** attempt
                if code == 403 and 'rate' not in detail.lower() and 'quota' not in detail.lower() and 'userRateLimit' not in detail:
                    raise RuntimeError(f'HTTP 403: {detail}')
                time.sleep(wait)
                continue
            raise RuntimeError(f'HTTP {code}: {detail}')
        except Exception:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise

# ---------- inventário ----------
def list_children(folder_id):
    items, token = [], None
    while True:
        params = {'q': f"'{folder_id}' in parents and trashed=false",
                  'fields': 'nextPageToken,files(id,name,mimeType,md5Checksum,size,shortcutDetails)',
                  'pageSize': 1000, 'supportsAllDrives': 'true',
                  'includeItemsFromAllDrives': 'true'}
        if token:
            params['pageToken'] = token
        r = api('GET', 'files', params)
        items += r.get('files', [])
        token = r.get('nextPageToken')
        if not token:
            return items

FOLDER = 'application/vnd.google-apps.folder'
SHORTCUT = 'application/vnd.google-apps.shortcut'

def walk(folder_id, path):
    """retorna lista de (path, fileobj) e dict de subpastas {path: None}"""
    files, folders = [], {}
    for it in list_children(folder_id):
        p = path + '/' + it['name']
        if it['mimeType'] == FOLDER:
            folders[p] = None
            f2, d2 = walk(it['id'], p)
            files += f2
            folders.update(d2)
        else:
            files.append((p, it))
    return files, folders

# ---------- agrupamento temático ----------
def norm(s):
    return unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()

GROUPS = [
    ('01 · Marca e Identidade Visual', ['identidade', 'logo', 'manual', 'capa', 'linkedin', 'assinatura', 'fundo', 'video', 'wallpaper']),
    ('02 · Comercial e Vendas', ['comercial', 'apresenta', 'case', 'atestado', 'diagn', 'midia', 'oferta', 'proposta']),
    ('03 · Capacitação e Onboarding', ['trilha', 'onboarding', 'educacional', 'treinament', 'capacita']),
    ('04 · Comunicação e Conteúdo', ['revista', 'rede', 'social', 'sociais', 'post', 'conteudo']),
]

def group_for(top_name):
    n = norm(top_name)
    for gname, kws in GROUPS:
        if any(k in n for k in kws):
            return gname
    return '05 · Outros'

# ---------- main ----------
def main():
    log('Inventariando árvore de origem...')
    files, folders = walk(SRC_ROOT, '')
    total_bytes = sum(int(f.get('size', 0)) for _, f in files)
    log(f'Inventário: {len(files)} arquivos, {len(folders)} pastas, {total_bytes/1e6:.1f} MB')

    # dedup global
    seen, plan, dups = {}, [], []
    for path, it in sorted(files, key=lambda x: x[0]):
        fid = it['id']
        if it['mimeType'] == SHORTCUT:
            tgt = (it.get('shortcutDetails') or {}).get('targetId')
            if not tgt:
                dups.append((path, 'atalho sem alvo — ignorado'))
                continue
            fid = tgt
        key = it.get('md5Checksum') or f"id:{fid}"
        namekey = (norm(it['name']), it.get('size'), it['mimeType'])
        if key in seen:
            dups.append((path, f"duplicado de {seen[key]}"))
            continue
        if it.get('md5Checksum') is None and namekey in seen:
            dups.append((path, f"duplicado (nome/tamanho) de {seen[namekey]}"))
            continue
        seen[key] = path
        seen[namekey] = path
        plan.append((path, fid, it['name']))
    log(f'Plano: {len(plan)} a copiar, {len(dups)} duplicados/atalhos pulados')

    # estrutura de destino
    def mkdir(name, parent):
        r = api('POST', 'files', params={'supportsAllDrives': 'true'},
                body={'name': name, 'mimeType': FOLDER, 'parents': [parent]})
        return r['id']

    root_id = mkdir(DEST_NAME, 'root')
    log(f'Pasta raiz criada: {root_id}')
    group_ids = {}
    folder_ids = {}  # caminho original -> id destino

    def dest_folder_for(path):
        """path = /TopPasta/sub/arquivo — resolve/cria a cadeia de pastas"""
        parts = [p for p in path.split('/') if p][:-1]
        if not parts:
            return root_id
        top = parts[0]
        g = group_for(top)
        if g not in group_ids:
            group_ids[g] = mkdir(g, root_id)
        cur_key, cur_id = '/' + top, None
        if cur_key in folder_ids:
            cur_id = folder_ids[cur_key]
        else:
            cur_id = mkdir(top, group_ids[g])
            folder_ids[cur_key] = cur_id
        for part in parts[1:]:
            cur_key += '/' + part
            if cur_key in folder_ids:
                cur_id = folder_ids[cur_key]
            else:
                cur_id = mkdir(part, cur_id)
                folder_ids[cur_key] = cur_id
        return cur_id

    copied, errors = [], []
    for i, (path, fid, name) in enumerate(plan, 1):
        try:
            parent = dest_folder_for(path)
            api('POST', f'files/{fid}/copy', params={'supportsAllDrives': 'true'},
                body={'name': name, 'parents': [parent]})
            copied.append(path)
        except Exception as e:
            errors.append((path, str(e)[:200]))
            log(f'ERRO em {path}: {str(e)[:200]}')
        if i % 25 == 0:
            log(f'Progresso: {i}/{len(plan)}')

    log(f'Cópia concluída: {len(copied)} ok, {len(errors)} erros')

    # índice como Google Doc
    lines = [f'ÍNDICE — Cópia dos materiais Grupo Studio ({time.strftime("%d/%m/%Y")})', '',
             f'Origem: pasta compartilhada "GS - Materiais Sócios e Parceiros"',
             f'Total copiado: {len(copied)} arquivos · Duplicados/atalhos pulados: {len(dups)} · Erros: {len(errors)}', '',
             'ESTRUTURA (agrupamento temático aplicado):']
    for g in sorted(group_ids):
        tops = sorted({k.split('/')[1] for k in folder_ids if group_for(k.split('/')[1]) == g})
        lines.append(f'  {g}')
        for t in tops:
            n = sum(1 for p in copied if p.startswith('/' + t + '/'))
            lines.append(f'    - {t} ({n} arquivos)')
    if dups:
        lines += ['', 'DUPLICADOS NÃO COPIADOS (mantida 1 via):']
        lines += [f'  - {p} → {r}' for p, r in dups[:120]]
        if len(dups) > 120:
            lines.append(f'  ... e mais {len(dups)-120}')
    if errors:
        lines += ['', 'ERROS:'] + [f'  - {p}: {e}' for p, e in errors]
    idx_text = '\n'.join(lines)

    boundary = 'xXbndXx'
    meta = json.dumps({'name': f'ÍNDICE — Cópia GS Materiais ({time.strftime("%Y-%m-%d")})',
                       'mimeType': 'application/vnd.google-apps.document',
                       'parents': [root_id]})
    mp = (f'--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n'
          f'--{boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n{idx_text}\r\n--{boundary}--')
    req = urllib.request.Request(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
        data=mp.encode(), method='POST',
        headers={'Authorization': f'Bearer {TOKEN}',
                 'Content-Type': f'multipart/related; boundary={boundary}'})
    with urllib.request.urlopen(req, timeout=60) as r:
        idx = json.load(r)
    log(f"Índice criado: {idx['id']}")

    json.dump({'root_id': root_id, 'root_link': f'https://drive.google.com/drive/folders/{root_id}',
               'copied': len(copied), 'dups': dups, 'errors': errors,
               'groups': {g: gid for g, gid in group_ids.items()},
               'total_bytes': total_bytes, 'index_id': idx['id']},
              open(OUT, 'w'), ensure_ascii=False, indent=1)
    log('FIM')

if __name__ == '__main__':
    main()
