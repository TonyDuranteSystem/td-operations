"""
Match the 170 'paid/overdue' rows from the Managed Clients finance xlsx
against sandbox accounts by normalized company name.

Output: /tmp/finance-match.json with
  matched:   [ {company, amount, paid_status, sandbox_account_id, sandbox_name} ]
  unmatched: [ {company, amount, paid_status, reason} ]

No DB writes. Just a diff.
"""
import json, os, re, sys
import pandas as pd

def norm(s):
    if s is None: return ''
    s = str(s).lower()
    s = s.replace('l.l.c.', 'llc').replace(' l.l.c', ' llc')
    s = re.sub(r'[^a-z0-9]', '', s)
    return s

# --- Read xlsx and filter to paid/overdue rows ---
df = pd.read_excel('/Users/10225office/Downloads/Managed Clients-Table 1.xlsx', sheet_name=0, header=None)
data = df.iloc[1:].reset_index(drop=True)
# drop the header row that sits inside the data
data = data[data[4] != 'Acct Status'].reset_index(drop=True)

# col 1 = company name, col 5 = status, col 6 = amount
rows = []
for _, r in data.iterrows():
    name = r[1]
    status_raw = r[5]
    amount_raw = r[6]
    status = str(status_raw).strip().lower() if pd.notna(status_raw) else ''
    is_paid = status in ('paid', 'overdue, paid')
    is_overdue = status == 'overdue'
    if not (is_paid or is_overdue):
        continue
    amount = None
    if pd.notna(amount_raw):
        try:
            amount = float(amount_raw)
        except Exception:
            amount = None
    rows.append({
        'company': str(name).strip(),
        'amount': amount,
        'paid_status': 'paid' if is_paid else 'overdue',
    })

print(f'xlsx paid+overdue rows: {len(rows)}')
paid_ct = sum(1 for r in rows if r['paid_status'] == 'paid')
print(f'  paid:    {paid_ct}')
print(f'  overdue: {len(rows) - paid_ct}')

# --- Query sandbox ---
# We don't have sandbox access from python; dump the rows and let node do the match.
with open('/tmp/finance-rows.json', 'w') as f:
    json.dump(rows, f, indent=2)
print('rows -> /tmp/finance-rows.json')
