import json, sys, urllib.request, urllib.parse
CRED='/home/hermes/.config/workspace-mcp/credentials/lucas@lucasjuridico.com.json'
def token():
    d=json.load(open(CRED))
    body=urllib.parse.urlencode({'client_id':d['client_id'],'client_secret':d['client_secret'],
      'refresh_token':d['refresh_token'],'grant_type':'refresh_token'}).encode()
    r=urllib.request.Request(d['token_uri'],data=body,headers={'Content-Type':'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(r,timeout=30) as x: return json.load(x)['access_token']
T=token()
def api(url, method='GET', payload=None):
    data=json.dumps(payload).encode() if payload is not None else None
    req=urllib.request.Request(url, data=data, method=method,
        headers={'Authorization':'Bearer '+T,'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=40) as x: return json.load(x)
    except urllib.error.HTTPError as e:
        print('HTTP',e.code,e.read().decode()[:800]); sys.exit(1)
if __name__=='__main__':
    q=urllib.parse.urlencode({'timeMin':'2026-09-10T00:00:00-03:00','timeMax':'2026-09-13T23:59:59-03:00',
      'singleEvents':'true','orderBy':'startTime','maxResults':'50'})
    r=api('https://www.googleapis.com/calendar/v3/calendars/primary/events?'+q)
    for e in r.get('items',[]):
        st=e.get('start',{}).get('dateTime') or e.get('start',{}).get('date')
        att=[a.get('email') for a in e.get('attendees',[])]
        print(f"{st} | {e.get('summary')} | id={e['id']} | meet={e.get('hangoutLink','-')} | att={att}")
