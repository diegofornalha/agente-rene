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
OLD='1O46KcDF9LiCxXsvOjZVLcnD9oOYAhpyO'   # pasta correta (ja compartilhada)
NEW='1NIpv79HBClNtwQxX3zbxnyaapmjnsg0g'   # duplicada criada agora
FILE='1NmL_FI-WpdvJyb-2sANXcqwHNdTQ3YP_'
print('pasta correta:', api('GET','files/'+OLD,{'fields':'id,name,createdTime'}))
# move arquivo
print('move:', api('PATCH','files/'+FILE,{'addParents':OLD,'removeParents':NEW,'fields':'id,name,parents,webViewLink'}))
# apaga duplicada
kids=api('GET','files',{'q':"'%s' in parents and trashed=false"%NEW,'fields':'files(id,name)'})
print('filhos da duplicada:',kids)
if not kids.get('files'):
    api('DELETE','files/'+NEW); print('duplicada removida')
# lista pasta correta + permissoes
print('conteudo:', api('GET','files',{'q':"'%s' in parents and trashed=false"%OLD,'fields':'files(id,name,size,mimeType)'}))
print('perms:', api('GET','files/%s/permissions'%OLD,{'fields':'permissions(id,type,role,emailAddress)'}))
