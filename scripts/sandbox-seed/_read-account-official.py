"""
Read Account_Official_Enriched_v7_2.numbers completely and dump to JSON.
Every row, every column. No skipping, no assumption.

The file has two data sheets: 'Managed Clients' and 'One-Time Clients'.
The header row lives in a separate table (Table 1-1) per Numbers export quirk.
"""
import json
from numbers_parser import Document

PATH = '/Users/10225office/Library/CloudStorage/GoogleDrive-support@tonydurante.us/Shared drives/Tony Durante LLC/Luca/Account_Official_Enriched_v7_2.numbers'
OUT = '/tmp/account-official-v7_2.json'

doc = Document(PATH)

result = {}
for sheet in doc.sheets:
    data_table = None
    header_table = None
    main_table = None
    for t in sheet.tables:
        rows = list(t.rows(values_only=True))
        if len(rows) == 1:
            header_table = rows
        else:
            main_table = rows
    if main_table is None:
        continue

    # If a separate 1-row header table exists, headers come from it and main_table is all data.
    # Otherwise the first row of main_table IS the header.
    if header_table:
        headers = header_table[0]
        data_rows = main_table
    else:
        headers = main_table[0]
        data_rows = main_table[1:]

    headers = [str(h).strip() if h is not None else f'col_{i}' for i, h in enumerate(headers)]
    rows_as_dict = []
    for r in data_rows:
        d = {}
        for i, val in enumerate(r):
            key = headers[i] if i < len(headers) else f'col_{i}'
            d[key] = val
        rows_as_dict.append(d)

    result[sheet.name] = {
        'headers': headers,
        'row_count': len(rows_as_dict),
        'rows': rows_as_dict,
    }

# dump
def default(o):
    from datetime import date, datetime, time
    if isinstance(o, (date, datetime, time)):
        return o.isoformat()
    return str(o)

with open(OUT, 'w') as f:
    json.dump(result, f, default=default, indent=2)

for sheet_name, sheet_data in result.items():
    print(f'{sheet_name}: {sheet_data["row_count"]} rows, {len(sheet_data["headers"])} columns')
    print(f'  headers: {sheet_data["headers"]}')
    print()

print(f'Full JSON -> {OUT}')
