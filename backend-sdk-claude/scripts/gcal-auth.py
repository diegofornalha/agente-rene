#!/usr/bin/env python3
"""Google Calendar OAuth2 authentication flow.
Run this script, open the URL it prints in a browser,
authorize, and paste the code back here."""

import json
import os
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ['https://www.googleapis.com/auth/calendar']
CREDS_FILE = os.path.expanduser('~/.config/gcalcli/oauth_credentials.json')
TOKEN_FILE = os.path.expanduser('~/.config/gcalcli/token.json')

def main():
    flow = InstalledAppFlow.from_client_secrets_file(CREDS_FILE, SCOPES)
    creds = flow.run_local_server(port=8090, open_browser=False)
    print('\n--- Abra este link no browser pra autorizar ---')
    print('(o servidor local em http://localhost:8090 vai capturar o redirect)')
    print()
    # Save token
    with open(TOKEN_FILE, 'w') as f:
        f.write(creds.to_json())
    print(f'\nToken salvo em {TOKEN_FILE}')
    print('Autenticação concluída com sucesso!')

if __name__ == '__main__':
    main()
