#!/usr/bin/env python3
import json, os, sys, time, urllib.request, urllib.parse, urllib.error

CRED = '/home/hermes/.config/workspace-mcp/credentials/lucas@lucasjuridico.com.json'
FILE = '/home/hermes/agente-rene/work/reuniao_video/reuniao_dcf_08set2026.mp4'
NAME = 'Reuniao_Capacitacao_DCF_2026-09-08.mp4'
FOLDER_NAME = 'Reunioes de Capacitacao'
CHUNK = 32 * 1024 * 1024

def token():
    d = json.load(open(CRED))
    body = urllib.parse.urlencode({'client_id': d['client_id'], 'client_secret': d['client_secret'],
        'refresh_token': d['refresh_token'], 'grant_type': 'refresh_token'}).encode()
    req = urllib.request.Request(d['token_uri'], data=body,
        headers={'Content-Type': 'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)['access_token']

TK = token()

def api(method, path, params=None, body=None):
    url = 'https://www.googleapis.com/drive/v3/' + path
    if params: url += '?' + urllib.parse.urlencode(params)
    hdrs = {'Authorization': 'Bearer ' + TK}
    data = None
    if body is not None:
        data = json.dumps(body).encode(); hdrs['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            t = r.read(); return json.loads(t) if t else {}
    except urllib.error.HTTPError as e:
        raise RuntimeError('HTTP %d: %s' % (e.code, e.read().decode()[:400]))

# folder
q = "mimeType='application/vnd.google-apps.folder' and name='%s' and trashed=false and 'root' in parents" % FOLDER_NAME
r = api('GET', 'files', {'q': q, 'fields': 'files(id,name)'})
if r.get('files'):
    fid = r['files'][0]['id']; print('folder exists', fid, flush=True)
else:
    fid = api('POST', 'files', body={'name': FOLDER_NAME,
        'mimeType': 'application/vnd.google-apps.folder', 'parents': ['root']})['id']
    print('folder created', fid, flush=True)

size = os.path.getsize(FILE)
print('size', size, flush=True)

# start resumable session
meta = json.dumps({'name': NAME, 'parents': [fid]}).encode()
req = urllib.request.Request(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,webViewLink',
    data=meta, method='POST',
    headers={'Authorization': 'Bearer ' + TK, 'Content-Type': 'application/json; charset=UTF-8',
             'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': str(size)})
with urllib.request.urlopen(req, timeout=60) as r:
    sess = r.headers['Location']
print('session ok', flush=True)

sent = 0
with open(FILE, 'rb') as fh:
    while sent < size:
        chunk = fh.read(CHUNK)
        end = sent + len(chunk) - 1
        for attempt in range(5):
            rq = urllib.request.Request(sess, data=chunk, method='PUT', headers={
                'Content-Length': str(len(chunk)),
                'Content-Range': 'bytes %d-%d/%d' % (sent, end, size)})
            try:
                with urllib.request.urlopen(rq, timeout=600) as r:
                    t = r.read()
                    res = json.loads(t) if t else {}
                sent = end + 1
                print('done %d/%d' % (sent, size), flush=True)
                break
            except urllib.error.HTTPError as e:
                if e.code == 308:
                    sent = end + 1
                    print('chunk %d/%d (%.0f%%)' % (sent, size, 100.0*sent/size), flush=True)
                    break
                if attempt == 4:
                    raise RuntimeError('HTTP %d: %s' % (e.code, e.read().decode()[:300]))
                time.sleep(2 ** attempt)
        else:
            raise RuntimeError('chunk failed')

print('UPLOADED', json.dumps(res), flush=True)
json.dump({'folder': fid, 'file': res}, open('/home/hermes/agente-rene/work/reuniao_video/result.json','w'))
