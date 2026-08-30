#!/usr/bin/env python3
import os, json, re, urllib.request, urllib.parse, sys, unicodedata
from collections import defaultdict

BASE = "https://crm.meulucroativo.seg.br/rest"
# load key from .env
KEY = None
with open("/home/hermes/agente-rene/backend-sdk-claude/.env") as f:
    for line in f:
        if line.startswith("TWENTY_API_KEY="):
            KEY = line.split("=",1)[1].strip()
            break
assert KEY, "no key"

def fetch(cursor=None):
    params = {"limit": "60"}
    if cursor:
        params["starting_after"] = cursor
    url = BASE + "/companies?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": "Bearer "+KEY, "User-Agent": "curl/8.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

rows = []
cursor = None
pages = 0
while True:
    d = fetch(cursor)
    comps = d["data"]["companies"]
    if not comps:
        break
    for c in comps:
        rows.append({
            "id": c["id"],
            "name": c.get("name") or "",
            "cnpj": c.get("cnpj") or "",
            "razao": c.get("razaoSocialOficial") or "",
            "tipo": c.get("tipoEntidade") or "",
            "status": c.get("statusCliente") or "",
            "uf": c.get("uf") or "",
            "created": c.get("createdAt") or "",
        })
    pages += 1
    pi = d.get("pageInfo") or {}
    if not pi.get("hasNextPage"):
        break
    cursor = pi.get("endCursor")
    if not cursor:
        break
    if pages > 200:
        break

print(f"TOTAL_FETCHED={len(rows)} PAGES={pages}", file=sys.stderr)

def norm_cnpj(s):
    return re.sub(r"\D", "", s or "")

def norm_name(s):
    s = s or ""
    s = unicodedata.normalize("NFKD", s).encode("ascii","ignore").decode()
    s = s.upper()
    # remove common company suffixes/noise
    s = re.sub(r"[^A-Z0-9 ]", " ", s)
    for suf in [" LTDA", " EIRELI", " ME", " EPP", " S A", " SA", " CIA", " & CIA"]:
        s = s.replace(suf, " ")
    s = re.sub(r"\s+", " ", s).strip()
    return s

# --- Group by normalized CNPJ (only valid 14-digit ones) ---
by_cnpj = defaultdict(list)
for r in rows:
    nc = norm_cnpj(r["cnpj"])
    if len(nc) == 14:
        by_cnpj[nc].append(r)

cnpj_dups = {k:v for k,v in by_cnpj.items() if len(v) > 1}

# --- Group by normalized NAME among records whose CNPJ is empty/invalid OR to catch cross-cnpj name repeats ---
by_name = defaultdict(list)
for r in rows:
    nn = norm_name(r["name"])
    if len(nn) >= 4:  # skip 1-3 char junk names like "A","B","GF"
        by_name[nn].append(r)
name_dups = {k:v for k,v in by_name.items() if len(v) > 1}

# name dups that are NOT already caught by cnpj dup (distinct cnpjs) -> potential dup w/ different/absent cnpj
name_only = {}
for k,v in name_dups.items():
    cnpjs = set(norm_cnpj(x["cnpj"]) for x in v)
    valid = set(c for c in cnpjs if len(c)==14)
    # if all share single valid cnpj it's already in cnpj_dups; flag when cnpjs differ or missing
    if len(valid) != 1 or any(len(norm_cnpj(x["cnpj"]))!=14 for x in v):
        name_only[k] = v

# CNPJ formatting inconsistency stat
fmt_with_punct = sum(1 for r in rows if re.search(r"[.\-/]", r["cnpj"]))
cnpj_filled = sum(1 for r in rows if norm_cnpj(r["cnpj"]))
cnpj_empty = len(rows) - cnpj_filled
cnpj_invalid = sum(1 for r in rows if r["cnpj"] and len(norm_cnpj(r["cnpj"]))!=14)

out = {
  "total": len(rows),
  "cnpj_filled": cnpj_filled,
  "cnpj_empty": cnpj_empty,
  "cnpj_with_punctuation": fmt_with_punct,
  "cnpj_invalid_len": cnpj_invalid,
  "cnpj_dup_groups": len(cnpj_dups),
  "cnpj_dup_records": sum(len(v) for v in cnpj_dups.values()),
  "name_dup_groups_extra": len(name_only),
}
print(json.dumps(out, ensure_ascii=False, indent=2))

def fmt_group(v):
    return [f'{x["name"]}  [{x["cnpj"] or "—"}] {x["tipo"]}/{x["status"] or "—"} {x["uf"] or ""} ({x["created"][:10]})' for x in v]

print("\n===== DUPLICADOS POR CNPJ (mesmo CNPJ, cadastros diferentes) =====")
for k,v in sorted(cnpj_dups.items(), key=lambda kv:-len(kv[1])):
    print(f"\nCNPJ {k}  ({len(v)} cadastros):")
    for line in fmt_group(v):
        print("   - "+line)

print("\n\n===== MESMO NOME, CNPJ DIFERENTE/AUSENTE (suspeita) =====")
for k,v in sorted(name_only.items(), key=lambda kv:-len(kv[1])):
    print(f"\n'{k}'  ({len(v)}):")
    for line in fmt_group(v):
        print("   - "+line)

# dump full to file for spreadsheet later
with open("/home/hermes/agente-rene/backend-sdk-claude/work/companies_all.json","w") as f:
    json.dump(rows, f, ensure_ascii=False)
