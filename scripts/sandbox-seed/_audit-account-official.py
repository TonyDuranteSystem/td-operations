"""
Full audit of the Account_Official file's internal state BEFORE any CRM comparison.
Goal: know exactly what the file is saying — distributions across every meaningful column.
No assumptions. Every row counted.
"""
import json
from collections import Counter, defaultdict

data = json.load(open('/tmp/account-official-v7_2.json'))

def dist(rows, col):
    c = Counter()
    for r in rows:
        v = r.get(col)
        if v is None or v == '':
            key = '(blank)'
        else:
            key = str(v).strip()
        c[key] += 1
    return c

def print_dist(title, rows, col, limit=None):
    print(f'--- {title}: "{col}" ---')
    c = dist(rows, col)
    items = sorted(c.items(), key=lambda x: -x[1])
    if limit:
        items = items[:limit]
    for k, v in items:
        print(f'  {v:5d}  {k}')
    print()

for sheet_name in ['Managed Clients', 'One-Time Clients']:
    rows = data[sheet_name]['rows']
    print(f'\n######## {sheet_name} — {len(rows)} rows ########\n')

    print_dist(sheet_name, rows, 'Client Type')
    print_dist(sheet_name, rows, 'Acct Status')
    print_dist(sheet_name, rows, 'TR Status')
    print_dist(sheet_name, rows, 'TR Stage')
    print_dist(sheet_name, rows, 'First Inst. Status')
    print_dist(sheet_name, rows, 'First Inst. $', limit=12)
    print_dist(sheet_name, rows, 'Second Inst. $', limit=12)
    if 'Second Inst. Status' in data[sheet_name]['headers']:
        print_dist(sheet_name, rows, 'Second Inst. Status')
    if 'Tax Return Status' in data[sheet_name]['headers']:
        print_dist(sheet_name, rows, 'Tax Return Status')
    print_dist(sheet_name, rows, 'Situazione Fattura')
    if 'Recurring Status' in data[sheet_name]['headers']:
        print_dist(sheet_name, rows, 'Recurring Status')
    print_dist(sheet_name, rows, 'Registered Agent', limit=8)
    print_dist(sheet_name, rows, 'Company Type', limit=8)
    print_dist(sheet_name, rows, 'State of Inc.', limit=8)

    # Service parsing
    print(f'--- {sheet_name}: "Client Services" (parsed) ---')
    services = Counter()
    for r in rows:
        s = r.get('Client Services')
        if not s or str(s).strip().upper() == 'MISSING':
            services['(missing/blank)'] += 1
            continue
        parts = [p.strip() for p in str(s).split(',')]
        for p in parts:
            services[p] += 1
    for k, v in services.most_common():
        print(f'  {v:5d}  {k}')
    print()

    # Count of MISSING values across columns
    missing_per_col = defaultdict(int)
    for r in rows:
        for col, v in r.items():
            if str(v).strip().upper() == 'MISSING':
                missing_per_col[col] += 1
    if missing_per_col:
        print(f'--- {sheet_name}: Explicit "MISSING" counts per column ---')
        for col, n in sorted(missing_per_col.items(), key=lambda x: -x[1]):
            print(f'  {n:5d}  {col}')
        print()
