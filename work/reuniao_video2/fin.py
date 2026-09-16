import json, urllib.request, urllib.parse, urllib.error
CRED='/home/hermes/.config/workspace-mcp/credentials/lucas@lucasjuridico.com.json'
d=json.load(open(CRED))
body=urllib.parse.urlencode({'client_id':d['client_id'],'client_secret':d['client_secret'],'refresh_token':d['refresh_token'],'grant_type':'refresh_token'}).encode()
TK=json.load(urllib.request.urlopen(urllib.request.Request(d['token_uri'],data=body,headers={'Content-Type':'application/x-www-form-urlencoded'})))['access_token']
def api(method,path,params=None,body=None):
    url='https://www.googleapis.com/drive/v3/'+path
    if params: url+='?'+urllib.parse.urlencode(params)
    h={'Authorization':'Bearer '+TK}; data=None
    if body is not None:
        data=json.dumps(body).encode(); h['Content-Type']='application/json'
    try:
        with urllib.request.urlopen(urllib.request.Request(url,data=data,headers=h,method=method),timeout=60) as r:
            t=r.read(); return json.loads(t) if t else {}
    except urllib.error.HTTPError as e:
        raise RuntimeError('HTTP %d: %s'%(e.code,e.read().decode()[:400]))
F='1NmL_FI-WpdvJyb-2sANXcqwHNdTQ3YP_'
print(api('PATCH','files/'+F,{'fields':'id,name,size,webViewLink'},{'name':'Reunião Alinhamento — 11-09-2026.mp4'}))
print(api('POST','files/%s/permissions'%F,{'sendNotificationEmail':'true','emailMessage':'Julio, segue a gravação da reunião de Alinhamento de 11/09.','fields':'id,role,emailAddress'},{'role':'reader','type':'user','emailAddress':'julio.cwb@gmail.com'}))
print(api('GET','files/%s/permissions'%F,{'fields':'permissions(type,role,emailAddress)'}))
