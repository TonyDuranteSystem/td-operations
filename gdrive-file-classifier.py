#!/usr/bin/env python3
"""
gdrive-file-classifier.py — Classifica e rinomina tutti i file client su GDrive

Fasi:
  python3 gdrive-file-classifier.py                    # Fase 1: Audit (solo report)
  python3 gdrive-file-classifier.py --apply             # Fase 2: Applica rinomina
  python3 gdrive-file-classifier.py --resume            # Riprendi audit interrotto
  python3 gdrive-file-classifier.py --client "B&P"      # Singolo client (test)
  python3 gdrive-file-classifier.py --state Wyoming     # Singolo stato
"""

import json, io, os, re, sys, time, logging, argparse
from datetime import datetime
from google.oauth2 import service_account
from googleapiclient.discovery import build
from PyPDF2 import PdfReader

# ══════════════════════════════════════════════════════════════
# CONFIGURAZIONE
# ══════════════════════════════════════════════════════════════
KEY_FILE = 'claude-gmail-connector-488713-4f9bfb44ea49.json'
IMPERSONATE_USER = 'support@tonydurante.us'

STATE_FOLDERS = {
    'Delaware': '1QoF8WZsW_TT-cXM9NxLeTN1ng1jqbZM-',
    'Florida': '1XToxqPl-t6z10raeal_frSpvBBBRY8nG',
    'New Mexico': '1tkJjg0HKbIl0uFzvK4zW3rtU14sdCHo4',
    'Wyoming': '110NUZZJC1mf3vKB12bmxfRFIVZJ3SE5x',
}

PROGRESS_FILE = 'classify-progress.json'
REPORT_FILE = 'classify-report.json'
SUMMARY_FILE = 'classify-summary.md'
LOG_FILE = 'classify.log'

API_DELAY = 0.12  # secondi tra chiamate API (rate limit safety)

# Client da escludere (struttura diversa o troppi file non-standard)
EXCLUDE_CLIENTS = [
    'beril', 'diendei', 'cirock', 'luvirope', 'lucky pama',
]

# ══════════════════════════════════════════════════════════════
# REGOLE DI CLASSIFICAZIONE — PAGE-BY-PAGE
#
# Problema risolto: con full-text matching, un Tax Return che
# contiene Form 8879 veniva classificato come Form 8879.
# Soluzione: classificare basandosi PRIMA sulla pagina 1 (header),
# poi full-text solo come fallback.
#
# Formato: (tipo, categoria, [patterns], [excludes], scope)
#   scope: 'page1' = solo pagina 1, 'all' = tutto il testo
#   categoria: 1=Company, 2=Contacts, 3=Tax, 4=Banking, 5=Correspondence
# ══════════════════════════════════════════════════════════════
RULES = [
    # ═══ PRIORITÀ 1: Tax Return Package (pagina 1 — cover page) ═══
    # NB: NO "government copy" — anche Form 8804 lo ha, ma non è Tax Return
    ('Tax Return', 3,
     [r'(?i)client.?s?\s+copy'],
     [], 'page1'),

    # ═══ PRIORITÀ 2: IRS Notices (pagina 1 — prima dei form!) ═══
    ('IRS Notice CP282', 5,
     [r'(?i)(?:notice\s+)?[CP]{1,2}\s*282'],
     [], 'page1'),
    ('IRS Notice', 5,
     [r'(?i)(notice\s+(?:CP|P)\s*\d{2,4}|LTR\s+\d+\s*C)'],
     [r'(?i)CP\s*575'], 'page1'),
    ('IRS Fax', 5,
     [r'(?i)fax\s+(transmission|cover)', r'(?i)(irs|internal\s+revenue)'],
     [], 'page1'),

    # ═══ PRIORITÀ 3: EIN Letter CP 575 (pagina 1) ═══
    ('EIN Letter (IRS)', 1,
     [r'(?i)(CP\s*575|we\s+(?:have\s+)?assigned\s+you\s+an?\s+employer\s+identification|your\s+(?:new\s+)?employer\s+identification\s+number)'],
     [], 'page1'),

    # ═══ PRIORITÀ 4: Data Collection / RF Forms (pagina 1) ═══
    ('RF 5472 (Data Collection)', 3,
     [r'(?i)(foreign\s+owned\s+single\s+member|RFForeign|single.member.*tax\s+filing\s+form)'],
     [r'(?i)department\s+of\s+the\s+treasury'], 'page1'),
    ('RF 1065 (Data Collection)', 3,
     [r'(?i)(form\s+1065\s+for\s+multi.member|multi.member.*llc.*partner)'],
     [r'(?i)department\s+of\s+the\s+treasury'], 'page1'),
    ('RF 1120 (Data Collection)', 3,
     [r'(?i)(c.?corp.*(?:data\s+collection|tax.*questionnaire|tax\s+filing))'],
     [r'(?i)department\s+of\s+the\s+treasury'], 'page1'),

    # ═══ PRIORITÀ 5: Form IRS specifici (pagina 1 — header) ═══
    ('Form 8879-PE (E-File Auth)', 3,
     [r'(?i)form\s+8879', r'(?i)(authorization|signature)'],
     [r'(?i)(client.?s?\s+copy|government\s+copy)'], 'page1'),
    ('Form 7004', 3,
     [r'(?i)form\s+7004', r'(?i)(extension|automatic)'],
     [], 'page1'),
    ('Form 8804-8805 (Partnership Withholding)', 3,
     [r'(?i)form\s+880[45]', r'(?i)(withholding|partnership)'],
     [r'(?i)(notice\s+CP|client.?s?\s+copy|form\s+7004)'], 'page1-2'),
    ('Form 5472', 3,
     [r'(?i)form\s+5472', r'(?i)(information\s+return|OMB\s+No)'],
     [r'(?i)(client.?s?\s+copy|questionnaire)'], 'page1'),
    ('Form 1120-F', 3,
     [r'(?i)form\s+1120.?F', r'(?i)(foreign\s+corporation|OMB)'],
     [r'(?i)client.?s?\s+copy'], 'page1'),
    ('Form 1120', 3,
     [r'(?i)form\s+1120(?!.?F)', r'(?i)(corporation\s+income\s+tax|OMB)'],
     [r'(?i)(client.?s?\s+copy|questionnaire)'], 'page1'),
    ('Form 1065', 3,
     [r'(?i)form\s+1065', r'(?i)(return\s+of\s+partnership|OMB)'],
     [r'(?i)(client.?s?\s+copy|multi.member.*questionnaire)'], 'page1'),
    ('Form 1040-NR', 3,
     [r'(?i)form\s+1040.?NR'],
     [r'(?i)client.?s?\s+copy'], 'page1'),
    ('Form W-7', 3,
     [r'(?i)form\s+w.?7', r'(?i)(individual\s+taxpayer|ITIN)'],
     [], 'page1'),
    ('Form SS-4', 1,
     [r'(?i)form\s+ss.?4', r'(?i)(employer\s+identification|OMB)'],
     [], 'page1'),

    # ═══ PRIORITÀ 6: Documenti Company (pagina 1 — titolo) ═══
    # NB: Operating Agreement PRIMA di Articles — perché OS Agreement
    # menziona spesso "articles of organization" nel testo di pagina 1
    ('Operating Agreement', 1,
     [r'(?i)(operating\s+agreement|limited\s+liability\s+company\s+agreement)'],
     [], 'page1'),
    ('Articles of Organization', 1,
     [r'(?i)(articles\s+of\s+organization|certificate\s+of\s+formation)'],
     [r'(?i)(operating\s+agreement|dissolution|dissolve)'], 'page1'),
    ('Certificate of Good Standing', 1,
     [r'(?i)(hereby\s+certif|I\s+certify).*(?:good\s+standing|exist|status|duly\s+organized)'],
     [], 'page1'),
    ('Registered Agent', 1,
     [r'(?i)(registered\s+agent\s+(?:consent|acceptance|resignation|change|statement)|(?:consent|acceptance)\s+(?:of|by)\s+registered\s+agent)'],
     [], 'page1'),
    ('Certificate of Dissolution', 1,
     [r'(?i)(certificate\s+of\s+dissolution|articles\s+of\s+dissolution|dissolv(?:e|ed|ing)\s+(?:the|this)\s+(?:company|llc|corporation))'],
     [], 'page1'),
    ('Annual Report', 1,
     [r'(?i)(annual\s+report|(?:division\s+of\s+corporations|document\s+number).*(?:annual|report))'],
     [r'(?i)(tax\s+return|good\s+standing|hereby\s+certif|payment\s+receipt|receipt\s+confirmation)'], 'page1'),
    # Florida Annual Reports — Sunbiz format (NB: page 1 ha "I hereby certify" — NON escluderlo)
    ('Annual Report', 1,
     [r'(?i)current\s+principal\s+place\s+of\s+business'],
     [r'(?i)(tax\s+return|payment\s+receipt|receipt\s+confirmation)'], 'page1'),
    ('EIN Cancellation Request', 1,
     [r'(?i)(close\s+(?:your\s+)?(?:business\s+)?account|cancel.*ein)'],
     [], 'page1'),
    ('Business License', 1,
     [r'(?i)(business\s+licen[sc]e|licen[sc]e\s+to\s+do\s+business)'],
     [], 'page1'),

    # ═══ PRIORITÀ 7: Full-text fallback ═══
    ('Tax Return', 3,
     [r'(?i)(prepared\s+for.*tax\s+return|enclosed\s+(?:is\s+)?your.*return)'],
     [], 'all'),

    # ─── Banking (pagina 1) ───
    ('Bank Statement', 4,
     [r'(?i)(bank\s+statement|account\s+statement|statement\s+period|(?:USD|EUR|GBP)\s+statement)'],
     [], 'page1'),
    ('Bank Statement', 4,
     [r'(?i)(account\s+(?:owner|details|number)|(?:wise|mercury|chase|relay|novo)\b)'],
     [r'(?i)(tax\s+return|annual\s+report|form\s+\d)'], 'page1'),
    ('Bank Application', 4,
     [r'(?i)(account\s+opening|bank.*application|new\s+account.*form)'],
     [], 'page1'),

    # ─── Contacts / ID (pagina 1) ───
    ('Passport', 2,
     [r'(?i)(passport|passeport|passaporto)'],
     [r'(?i)(form\s+\d|department\s+of\s+the\s+treasury|internal\s+revenue|bank\s+statement|receipt|ein\s+|employer\s+identification)'], 'page1'),
    ('ID Document', 2,
     [r'(?i)(driver.?s?\s+licen[sc]e|identity\s+card|carta\s+d.?identit)'],
     [], 'page1'),
    ('Proof of Address', 2,
     [r'(?i)(proof\s+of\s+address|estratto\s+conto|utility\s+bill|bank\s+reference\s+letter)'],
     [], 'page1'),
    ('Utility Bill', 2,
     [r'(?i)(utility\s+bill|electric\s+(?:bill|statement))'],
     [], 'page1'),

    # ─── Company (pagina 1) ───
    ('BOI Report', 1,
     [r'(?i)(beneficial\s+ownership|boi\b|fincen\b)'],
     [], 'page1'),
    ('Office Lease', 1,
     [r'(?i)(rent\s+office\s+agreement|office\s+lease|(?:virtual\s+)?office\s+(?:agreement|contract)|lease\s+agreement)'],
     [], 'page1-2'),
    ('Profit & Loss Statement', 1,
     [r'(?i)(profit\s*(?:&|and)\s*loss|income\s+statement|P\s*&\s*L\s+statement)'],
     [], 'page1'),

    # ─── Correspondence (pagina 1) ───
    ('Offer Letter', 5,
     [r'(?i)(proposta\s+(?:commerciale|economica)|offerta|proposal|engagement\s+letter|tony\s+durante\s+llc.*(?:serviz|pric|fee))'],
     [], 'page1'),
    ('IRS E-File Acknowledgment', 5,
     [r'(?i)(acknowledg(?:e)?ment.*(?:entit|file|electronic)|e.?file\s+(?:ack|confirm)|file\s+returns?\s+electronically)'],
     [], 'page1'),
    ('ITIN Letter', 2,
     [r'(?i)(individual\s+taxpayer\s+identification|ITIN\s+(?:application|letter|assign))'],
     [], 'page1'),
    ('Fax Confirmation', 5,
     [r'(?i)(fax\s+(?:transmission|confirmation|cover)|facsimile)'],
     [], 'page1'),
    ('Receipt', 5,
     [r'(?i)((?:payment\s+)?receipt|ricevuta|payment\s+(?:confirmation|received))'],
     [r'(?i)tax\s+return'], 'page1'),
]

# ══════════════════════════════════════════════════════════════
# AUTH & DRIVE
# ══════════════════════════════════════════════════════════════
def get_drive():
    creds = service_account.Credentials.from_service_account_file(
        KEY_FILE,
        scopes=['https://www.googleapis.com/auth/drive'],
        subject=IMPERSONATE_USER
    )
    return build('drive', 'v3', credentials=creds)


def list_children(drive, folder_id):
    """Lista tutti i figli di una cartella (con paginazione)"""
    items = []
    page_token = None
    while True:
        resp = drive.files().list(
            q=f"'{folder_id}' in parents and trashed = false",
            fields='nextPageToken, files(id, name, mimeType, size)',
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
            pageSize=1000,
            pageToken=page_token
        ).execute()
        items.extend(resp.get('files', []))
        page_token = resp.get('nextPageToken')
        if not page_token:
            break
        time.sleep(API_DELAY)
    return items


def download_file(drive, file_id):
    """Scarica il contenuto di un file"""
    return drive.files().get_media(fileId=file_id, supportsAllDrives=True).execute()


# ══════════════════════════════════════════════════════════════
# ESTRAZIONE TESTO — PAGE BY PAGE
# ══════════════════════════════════════════════════════════════
def normalize_text(text):
    """Normalizza testo garbled da PyPDF2 — collassa spazi multipli"""
    # "Fo m 1065 f or Multi-Member" → "Form 1065 for Multi-Member"
    text = re.sub(r'(\w) (\w) ', r'\1\2 ', text)  # singoli char spaziati
    text = re.sub(r' {2,}', ' ', text)  # spazi multipli
    return text


def extract_pages(content):
    """Estrae testo pagina per pagina da PDF.
    Returns: list of page texts (anche vuote)"""
    try:
        reader = PdfReader(io.BytesIO(content))
        pages = []
        for page in reader.pages[:10]:
            t = page.extract_text()
            pages.append(normalize_text(t.strip()) if t else '')
        return pages
    except Exception:
        return []


# ══════════════════════════════════════════════════════════════
# CLASSIFICAZIONE — PAGE-AWARE
# ══════════════════════════════════════════════════════════════
def classify_document(pages):
    """Classifica documento basandosi su pagina 1 + full text.
    Returns: (doc_type, target_category) oppure None"""
    if not pages:
        return None

    page1 = pages[0] if pages else ''
    page1_2 = '\n'.join(pages[:2]) if len(pages) > 1 else page1
    all_text = '\n'.join(pages)

    # Testo troppo corto
    total_len = len(all_text.strip())
    if total_len < 20:
        return None

    for doc_type, category, patterns, excludes, scope in RULES:
        if scope == 'page1':
            text = page1
        elif scope == 'page1-2':
            text = page1_2
        else:
            text = all_text

        all_match = all(re.search(p, text) for p in patterns)
        any_exclude = any(re.search(p, text) for p in excludes)

        if all_match and not any_exclude:
            return (doc_type, category)

    return None


def detect_year(all_text):
    """Rileva anno fiscale dal testo.
    Priorità: pattern tax-specific > December 31 > date generiche.
    Per Tax Returns, l'anno fiscale è sempre < anno di preparazione."""

    # Fase 1: Pattern specifici per anno fiscale
    primary_patterns = [
        r'(?i)tax\s+(?:year|period)\s+(?:ending\s+)?(?:december\s+31,?\s+)?(\d{4})',
        r'(?i)for\s+(?:the\s+)?(?:calendar\s+)?year\s+(\d{4})',
        r'(?i)(?:tax\s+)?year\s+ending\s+(\d{4})',
        r'(?i)(\d{4})\s+(?:tax\s+return|annual\s+report)',
        r'(?i)tax\s+period\s+(?:\w+\s+\d{1,2},?\s+)?(\d{4})',
        r'(?i)december\s+31,?\s+(\d{4})',
        r'(?i)report\s+year\s+(\d{4})',
        # Pattern per amended returns: "your 2023 amended return"
        r'(?i)your\s+(\d{4})\s+(?:amended\s+)?(?:\w+\s+)?(?:return|tax)',
        # "2023 U.S. Amended Return" / "2023 amended partnership"
        r'(?i)(\d{4})\s+(?:u\.?s\.?\s+)?(?:amended|partnership|return)',
    ]
    from collections import Counter
    year_counts = Counter()
    for p in primary_patterns:
        for m in re.finditer(p, all_text):
            y = int(m.group(1))
            if 2015 <= y <= 2030:
                year_counts[y] += 1
    if year_counts:
        # Anno più frequente; a parità, il più basso (anno fiscale < filing)
        max_count = max(year_counts.values())
        candidates = [y for y, c in year_counts.items() if c == max_count]
        return min(candidates)

    # Fase 2: Fallback — date generiche (solo se nessun pattern primario)
    fallback_patterns = [
        r'(?i)(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+(\d{4})',
    ]
    for p in fallback_patterns:
        for m in re.finditer(p, all_text):
            y = int(m.group(1))
            if 2015 <= y <= 2030:
                year_counts[y] += 1
    if year_counts:
        max_count = max(year_counts.values())
        candidates = [y for y, c in year_counts.items() if c == max_count]
        return min(candidates)
    return None


def detect_amended(all_text):
    """Rileva se e' un return amended"""
    return bool(re.search(r'(?i)(amended|amendment|1065.?X|1120.?X|1040.?X)', all_text))


# Tipi che richiedono anno nel nome
YEAR_TYPES = {
    'Tax Return', 'Form 8879-PE (E-File Auth)',
    'Form 8804-8805 (Partnership Withholding)',
    'Form 5472', 'Form 1120', 'Form 1120-F', 'Form 1065',
    'Form 1040-NR', 'Form W-7',
    'RF 5472 (Data Collection)', 'RF 1065 (Data Collection)',
    'RF 1120 (Data Collection)', 'Annual Report',
}


def build_correct_name(doc_type, year, amended, company_name, ext):
    """Costruisce il nome file corretto"""
    name = doc_type
    if year and doc_type in YEAR_TYPES:
        name += f' {year}'
    if amended and 'Tax Return' in doc_type:
        name += ' (Amended)'
    name += f' - {company_name}{ext}'
    return name


# ══════════════════════════════════════════════════════════════
# SUBFOLDER HELPERS
# ══════════════════════════════════════════════════════════════
def get_subfolder_category(folder_name):
    """Numero categoria da nome subfolder (1-5)"""
    fn = folder_name.lower()
    if fn.startswith('1.') or fn.startswith('1 '):
        return 1
    if fn.startswith('2.') or fn.startswith('2 '):
        return 2
    if fn.startswith('3.') or fn.startswith('3 '):
        return 3
    if fn.startswith('4.') or fn.startswith('4 '):
        return 4
    if fn.startswith('5.') or fn.startswith('5 '):
        return 5
    return None


CATEGORY_NAMES = {
    1: '1. Company', 2: '2. Contacts', 3: '3. Tax',
    4: '4. Banking', 5: '5. Correspondence'
}


# ══════════════════════════════════════════════════════════════
# FILE TREE BUILDER
# ══════════════════════════════════════════════════════════════
def get_all_files(drive, folder_id, path='', depth=0):
    """Elenca ricorsivamente tutti i file con path relativo e parent_id"""
    if depth > 5:
        return []

    items = list_children(drive, folder_id)
    files = []

    for item in items:
        item_path = f"{path}/{item['name']}" if path else item['name']

        if item['mimeType'] == 'application/vnd.google-apps.folder':
            files.extend(get_all_files(drive, item['id'], item_path, depth + 1))
        else:
            item['path'] = item_path
            item['parent_id'] = folder_id
            files.append(item)

    return files


# ══════════════════════════════════════════════════════════════
# APPLY LOGIC
# ══════════════════════════════════════════════════════════════
def apply_change(drive, file_record, subfolder_map, client_folder_id, log):
    """Applica rinomina e/o spostamento di un file"""
    file_id = file_record['id']
    parent_id = file_record.get('_parent_id', '')

    update_body = {}
    kwargs = {'fileId': file_id, 'supportsAllDrives': True}

    if file_record.get('proposed_name'):
        update_body['name'] = file_record['proposed_name']

    target_cat = file_record.get('proposed_folder')
    if target_cat and target_cat in subfolder_map:
        target_folder_id = subfolder_map[target_cat]['id']

        year = file_record.get('year')
        if target_cat == 3 and year:
            year_folders = list_children(drive, target_folder_id)
            year_folder = next(
                (f for f in year_folders
                 if f['name'] == str(year)
                 and f['mimeType'] == 'application/vnd.google-apps.folder'),
                None
            )
            if year_folder:
                target_folder_id = year_folder['id']
            else:
                new_folder = drive.files().create(
                    body={
                        'name': str(year),
                        'mimeType': 'application/vnd.google-apps.folder',
                        'parents': [target_folder_id]
                    },
                    supportsAllDrives=True,
                    fields='id'
                ).execute()
                target_folder_id = new_folder['id']
                log.info(f'    Created year folder: {year}')

        kwargs['addParents'] = target_folder_id
        kwargs['removeParents'] = parent_id

    if update_body:
        kwargs['body'] = update_body

    drive.files().update(**kwargs).execute()
    time.sleep(API_DELAY)


# ══════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════
def main():
    parser = argparse.ArgumentParser(description='GDrive File Classifier')
    parser.add_argument('--apply', action='store_true', help='Applica rinomina (Fase 2)')
    parser.add_argument('--resume', action='store_true', help='Riprendi audit interrotto')
    parser.add_argument('--client', type=str, help='Singolo client (substring match)')
    parser.add_argument('--state', type=str, help='Singolo stato')
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(levelname)s %(message)s',
        handlers=[
            logging.FileHandler(LOG_FILE, mode='a'),
            logging.StreamHandler()
        ]
    )
    log = logging.getLogger()

    mode = 'APPLY' if args.apply else 'AUDIT'
    log.info(f'=== GDrive File Classifier — Mode: {mode} ===')

    drive = get_drive()
    log.info('Connesso a Google Drive')

    progress = {}
    if args.resume and os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE) as f:
            progress = json.load(f)
        log.info(f'Ripresa: {len(progress.get("done_clients", []))} client gia processati')

    done_clients = set(progress.get('done_clients', []))
    results = progress.get('results', {})
    stats = progress.get('stats', {
        'total_files': 0, 'classified': 0, 'needs_ocr': 0,
        'correct': 0, 'needs_rename': 0, 'needs_move': 0,
        'needs_rename_and_move': 0, 'unclassified': 0,
        'errors': 0, 'skipped': 0
    })

    states = STATE_FOLDERS
    if args.state:
        states = {k: v for k, v in STATE_FOLDERS.items()
                  if k.lower() == args.state.lower()}
        if not states:
            log.error(f'Stato "{args.state}" non trovato')
            sys.exit(1)

    for state_name, state_folder_id in states.items():
        log.info(f'\n{"="*60}')
        log.info(f'STATO: {state_name}')
        log.info(f'{"="*60}')

        clients = list_children(drive, state_folder_id)
        clients = [c for c in clients
                   if c['mimeType'] == 'application/vnd.google-apps.folder']
        clients.sort(key=lambda x: x['name'])

        for ci, client in enumerate(clients):
            client_name = client['name']
            client_id = client['id']

            if args.client and args.client.lower() not in client_name.lower():
                continue

            # Skip excluded clients
            if any(exc in client_name.lower() for exc in EXCLUDE_CLIENTS):
                continue

            if client_id in done_clients:
                continue

            log.info(f'\n[{state_name}] ({ci+1}/{len(clients)}) {client_name}')

            subfolders = list_children(drive, client_id)
            subfolder_map = {}
            for sf in subfolders:
                if sf['mimeType'] == 'application/vnd.google-apps.folder':
                    cat = get_subfolder_category(sf['name'])
                    if cat:
                        subfolder_map[cat] = {'id': sf['id'], 'name': sf['name']}

            all_files = get_all_files(drive, client_id)
            log.info(f'  {len(all_files)} file trovati')

            client_files = []

            for fi, file in enumerate(all_files):
                stats['total_files'] += 1
                file_name = file['name']
                file_id = file['id']
                size = int(file.get('size', 0))
                path = file['path']

                path_parts = path.split('/')
                current_category = None
                if len(path_parts) > 1:
                    current_category = get_subfolder_category(path_parts[0])

                ext = os.path.splitext(file_name)[1].lower()
                if ext not in ('.pdf',):
                    stats['skipped'] += 1
                    client_files.append({
                        'id': file_id, 'name': file_name, 'path': path,
                        'status': 'SKIPPED', 'reason': f'non-PDF ({ext or "no ext"})'
                    })
                    continue

                if size > 20 * 1024 * 1024:
                    stats['skipped'] += 1
                    client_files.append({
                        'id': file_id, 'name': file_name, 'path': path,
                        'status': 'SKIPPED', 'reason': f'too large ({size/1024/1024:.1f}MB)'
                    })
                    continue

                try:
                    content = download_file(drive, file_id)
                    time.sleep(API_DELAY)
                    pages = extract_pages(content)
                except Exception as e:
                    stats['errors'] += 1
                    log.error(f'  ERROR: {file_name}: {e}')
                    client_files.append({
                        'id': file_id, 'name': file_name, 'path': path,
                        'status': 'ERROR', 'error': str(e)
                    })
                    continue

                all_text = '\n'.join(pages)
                if not all_text or len(all_text.strip()) < 20:
                    stats['needs_ocr'] += 1
                    client_files.append({
                        'id': file_id, 'name': file_name, 'path': path,
                        'status': 'NEEDS_OCR', 'size_kb': round(size / 1024)
                    })
                    continue

                result = classify_document(pages)

                if not result:
                    stats['unclassified'] += 1
                    client_files.append({
                        'id': file_id, 'name': file_name, 'path': path,
                        'status': 'UNCLASSIFIED',
                        'snippet': (pages[0] if pages else '')[:300].replace('\n', ' ')
                    })
                    continue

                doc_type, target_category = result
                stats['classified'] += 1

                year = detect_year(all_text) if doc_type in YEAR_TYPES else None
                amended = detect_amended(all_text) if 'Tax Return' in doc_type else False

                correct_name = build_correct_name(doc_type, year, amended, client_name, ext)

                needs_rename = (file_name != correct_name)
                needs_move = (current_category is not None
                              and current_category != target_category)

                if needs_rename and needs_move:
                    status = 'RENAME_AND_MOVE'
                    stats['needs_rename_and_move'] += 1
                elif needs_rename:
                    status = 'RENAME'
                    stats['needs_rename'] += 1
                elif needs_move:
                    status = 'MOVE'
                    stats['needs_move'] += 1
                else:
                    status = 'OK'
                    stats['correct'] += 1

                record = {
                    'id': file_id, 'name': file_name, 'path': path,
                    'classified_as': doc_type, 'status': status,
                }

                if needs_rename:
                    record['proposed_name'] = correct_name
                if needs_move:
                    record['current_folder'] = CATEGORY_NAMES.get(current_category, '?')
                    record['proposed_folder'] = target_category
                    record['proposed_folder_name'] = CATEGORY_NAMES.get(target_category, '?')
                if year:
                    record['year'] = year
                if amended:
                    record['amended'] = True

                if args.apply and status != 'OK':
                    try:
                        record['_parent_id'] = file['parent_id']
                        apply_change(drive, record, subfolder_map, client_id, log)
                        record.pop('_parent_id', None)
                        record['applied'] = True
                        log.info(f'  APPLIED: {file_name} -> {correct_name}')
                    except Exception as e:
                        record['applied'] = False
                        record['apply_error'] = str(e)
                        log.error(f'  APPLY ERROR: {file_name}: {e}')

                client_files.append(record)

                if (fi + 1) % 50 == 0:
                    log.info(f'  ... {fi+1}/{len(all_files)} file processati')

            changes = sum(1 for f in client_files if f['status'] in
                         ('RENAME', 'MOVE', 'RENAME_AND_MOVE'))
            ocr_needed = sum(1 for f in client_files if f['status'] == 'NEEDS_OCR')
            unclass = sum(1 for f in client_files if f['status'] == 'UNCLASSIFIED')

            results[client_id] = {
                'name': client_name, 'state': state_name,
                'total_files': len(all_files), 'changes': changes,
                'ocr_needed': ocr_needed, 'unclassified': unclass,
                'files': client_files
            }
            done_clients.add(client_id)

            log.info(f'  Risultato: {len(all_files)} file, '
                     f'{changes} da cambiare, {ocr_needed} OCR, {unclass} non classificati')

            with open(PROGRESS_FILE, 'w') as f:
                json.dump({
                    'done_clients': list(done_clients),
                    'results': results, 'stats': stats,
                    'last_update': datetime.now().isoformat()
                }, f, ensure_ascii=False)

    # ─── Report finale ───
    report = {
        'timestamp': datetime.now().isoformat(),
        'mode': mode, 'stats': stats, 'clients': results
    }
    with open(REPORT_FILE, 'w') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    # ─── Summary leggibile ───
    summary_lines = [
        f'# GDrive File Classification Report',
        f'**Data:** {datetime.now().strftime("%Y-%m-%d %H:%M")}',
        f'**Modalita:** {mode}', '',
        f'## Statistiche',
        f'| Metrica | Valore |', f'|---------|--------|',
        f'| File totali | {stats["total_files"]} |',
        f'| Classificati | {stats["classified"]} |',
        f'| Nome corretto | {stats["correct"]} |',
        f'| Da rinominare | {stats["needs_rename"]} |',
        f'| Da spostare | {stats["needs_move"]} |',
        f'| Da rinominare + spostare | {stats["needs_rename_and_move"]} |',
        f'| Non classificati | {stats["unclassified"]} |',
        f'| Serve OCR | {stats["needs_ocr"]} |',
        f'| Saltati (non-PDF) | {stats["skipped"]} |',
        f'| Errori | {stats["errors"]} |',
        '', f'## Client con piu cambiamenti',
    ]

    client_changes = []
    for cid, cdata in results.items():
        if cdata.get('changes', 0) > 0:
            client_changes.append((cdata['name'], cdata['state'], cdata['changes']))
    client_changes.sort(key=lambda x: -x[2])
    for name, state, changes in client_changes[:20]:
        summary_lines.append(f'- **{name}** ({state}): {changes} file')

    summary_lines.extend([
        '', f'## Cambiamenti proposti (primi 100)',
        f'| Client | File attuale | Tipo rilevato | Azione | Nuovo nome |',
        f'|--------|-------------|---------------|--------|-----------|',
    ])

    change_count = 0
    for cid, cdata in results.items():
        for fr in cdata.get('files', []):
            if fr['status'] in ('RENAME', 'MOVE', 'RENAME_AND_MOVE') and change_count < 100:
                action = fr['status'].replace('_', ' ').title()
                new_name = fr.get('proposed_name', fr['name'])
                short_name = fr['name'][:40] + ('...' if len(fr['name']) > 40 else '')
                short_new = new_name[:40] + ('...' if len(new_name) > 40 else '')
                summary_lines.append(
                    f'| {cdata["name"][:30]} | {short_name} | '
                    f'{fr.get("classified_as", "?")} | {action} | {short_new} |'
                )
                change_count += 1

    with open(SUMMARY_FILE, 'w') as f:
        f.write('\n'.join(summary_lines))

    log.info(f'\n{"="*60}')
    log.info(f'RIEPILOGO FINALE')
    log.info(f'{"="*60}')
    log.info(f'File totali:              {stats["total_files"]}')
    log.info(f'Classificati:             {stats["classified"]}')
    log.info(f'  - Nome corretto:        {stats["correct"]}')
    log.info(f'  - Da rinominare:        {stats["needs_rename"]}')
    log.info(f'  - Da spostare:          {stats["needs_move"]}')
    log.info(f'  - Rinomina + spostare:  {stats["needs_rename_and_move"]}')
    log.info(f'Non classificati:         {stats["unclassified"]}')
    log.info(f'Serve OCR:                {stats["needs_ocr"]}')
    log.info(f'Saltati (non-PDF):        {stats["skipped"]}')
    log.info(f'Errori:                   {stats["errors"]}')
    log.info(f'Report JSON: {REPORT_FILE}')
    log.info(f'Summary MD:  {SUMMARY_FILE}')


if __name__ == '__main__':
    main()
