#!/usr/bin/env python3
"""Minimal Google Drive v3 helper (direct REST, refresh token)."""
import json, os, sys, urllib.request, urllib.parse, urllib.error, mimetypes, time

CRED = '/home/hermes/.config/workspace-mcp/credentials/lucas@lucasjuridico.com.json'
_tk = {'v': None, 'exp': 0}

def token():
    if _tk['v'] and time.time() < _tk['exp'] - 60:
        return _tk['v']
    d = json.load(open(CRED))
    body = urllib.parse.urlencode({'client_id': d['client_id'], 'client_secret': d['client_secret'],
        'refresh_token': d['refresh_token'], 'grant_type': 'refresh_token'}).encode()
    req = urllib.request.Request(d['token_uri'], data=body,
        headers={'Content-Type': 'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(req, timeout=30) as r:
        j = json.load(r)
    _tk['v'] = j['access_token']; _tk['exp'] = time.time() + j.get('expires_in', 3600)
    return _tk['v']

def api(method, path, params=None, body=None, base='https://www.googleapis.com/drive/v3/'):
    url = base + path
    if params: url += '?' + urllib.parse.urlencode(params)
    hdrs = {'Authorization': 'Bearer ' + token()}
    data = None
    if body is not None:
        data = json.dumps(body).encode(); hdrs['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                t = r.read(); return json.loads(t) if t else {}
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:500]
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(2 ** attempt); continue
            raise RuntimeError('HTTP %d %s %s :: %s' % (e.code, method, path, msg))

def ls(q, fields='files(id,name,mimeType,size,modifiedTime,parents,owners(emailAddress))', page_size=200):
    out, tok = [], None
    while True:
        p = {'q': q, 'fields': 'nextPageToken,' + fields, 'pageSize': page_size,
             'supportsAllDrives': 'true', 'includeItemsFromAllDrives': 'true'}
        if tok: p['pageToken'] = tok
        r = api('GET', 'files', p)
        out += r.get('files', [])
        tok = r.get('nextPageToken')
        if not tok: break
    return out

def mkfolder(name, parent='root'):
    q = ("mimeType='application/vnd.google-apps.folder' and name=%s and trashed=false and %s in parents"
         % (json.dumps(name), json.dumps(parent)))
    ex = ls(q, fields='files(id,name)')
    if ex: return ex[0]['id']
    r = api('POST', 'files', {'fields': 'id'},
            {'name': name, 'mimeType': 'application/vnd.google-apps.folder', 'parents': [parent]})
    return r['id']

def upload(path, parent, name=None, mime=None):
    name = name or os.path.basename(path)
    mime = mime or mimetypes.guess_type(name)[0] or 'application/octet-stream'
    size = os.path.getsize(path)
    meta = {'name': name, 'parents': [parent]}
    req = urllib.request.Request(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink',
        data=json.dumps(meta).encode(),
        headers={'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json; charset=UTF-8',
                 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': str(size)}, method='POST')
    with urllib.request.urlopen(req, timeout=60) as r:
        loc = r.headers['Location']
    with open(path, 'rb') as f:
        data = f.read()
    req2 = urllib.request.Request(loc, data=data,
        headers={'Content-Type': mime, 'Content-Length': str(size)}, method='PUT')
    with urllib.request.urlopen(req2, timeout=900) as r:
        return json.loads(r.read())

def download(fid, dest):
    req = urllib.request.Request('https://www.googleapis.com/drive/v3/files/%s?alt=media&supportsAllDrives=true' % fid,
                                 headers={'Authorization': 'Bearer ' + token()})
    with urllib.request.urlopen(req, timeout=900) as r, open(dest, 'wb') as f:
        while True:
            b = r.read(1 << 20)
            if not b: break
            f.write(b)
    return dest

def export(fid, dest, mime):
    p = urllib.parse.urlencode({'mimeType': mime})
    req = urllib.request.Request('https://www.googleapis.com/drive/v3/files/%s/export?%s' % (fid, p),
                                 headers={'Authorization': 'Bearer ' + token()})
    with urllib.request.urlopen(req, timeout=900) as r, open(dest, 'wb') as f:
        f.write(r.read())
    return dest

if __name__ == '__main__':
    print(json.dumps(api('GET', 'about', {'fields': 'user(emailAddress,displayName),storageQuota'}), indent=1))
