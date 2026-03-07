import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { SignJWT, importPKCS8 } from "jose";

export const maxDuration = 300;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ROOT_FOLDER_ID = "1EdxwvqFTlmMbO9lVRwlV9tKklqbXcMy0";
const BUCKET = "td-operations";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

const EXPORT_MAP: Record<string, [string, string]> = {
  "application/vnd.google-apps.document": ["application/pdf", ".pdf"],
  "application/vnd.google-apps.spreadsheet": [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsx",
  ],
  "application/vnd.google-apps.presentation": ["application/pdf", ".pdf"],
  "application/vnd.google-apps.drawing": ["application/pdf", ".pdf"],
};

const SKIP_MIMES = new Set([
  "application/vnd.google-apps.shortcut",
  "application/vnd.google-apps.form",
]);

// --- Google Auth (reuses same pattern as lib/google-drive.ts) ---

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000) {
    return cachedToken.token;
  }

  const b64 = process.env.GOOGLE_SA_KEY;
  if (!b64) throw new Error("GOOGLE_SA_KEY not configured");
  const creds = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));

  const privateKey = await importPKCS8(creds.private_key, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({
    scope: "https://www.googleapis.com/auth/drive.readonly",
    sub: process.env.GOOGLE_IMPERSONATE_EMAIL || "support@tonydurante.us",
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(creds.client_email)
    .setAudience(creds.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const res = await fetch(creds.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`OAuth error: ${await res.text()}`);
  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

// --- Drive helpers ---

async function listFolder(token: string, folderId: string) {
  const items: any[] = [];
  let pageToken = "";
  do {
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set(
      "q",
      `'${folderId}' in parents and trashed = false`
    );
    url.searchParams.set(
      "fields",
      "nextPageToken,files(id,name,mimeType,size,modifiedTime)"
    );
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();
    items.push(...(data.files || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return items;
}

async function downloadFile(
  token: string,
  fileId: string,
  mimeType: string
): Promise<{ data: Buffer; contentType: string }> {
  let url: string;
  let ct: string;

  if (EXPORT_MAP[mimeType]) {
    const [exportMime] = EXPORT_MAP[mimeType];
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`;
    ct = exportMime;
  } else {
    url = `${DRIVE_API}/files/${fileId}?alt=media`;
    ct = mimeType;
  }

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Download ${resp.status}: ${resp.statusText}`);
  const ab = await resp.arrayBuffer();
  return { data: Buffer.from(ab), contentType: ct };
}

// --- Sync logic ---

interface Stats {
  uploaded: number;
  unchanged: number;
  failed: number;
  skipped: number;
  errors: string[];
}

async function syncFolder(
  token: string,
  supabase: any,
  folderId: string,
  pathPrefix: string,
  stats: Stats
) {
  const items = await listFolder(token, folderId);

  for (const item of items) {
    const { name, mimeType, id: fileId, modifiedTime } = item;

    if (mimeType === "application/vnd.google-apps.folder") {
      await syncFolder(
        token,
        supabase,
        fileId,
        pathPrefix ? `${pathPrefix}${name}/` : `${name}/`,
        stats
      );
      continue;
    }

    if (SKIP_MIMES.has(mimeType)) {
      stats.skipped++;
      continue;
    }

    let finalName = name;
    if (EXPORT_MAP[mimeType]) {
      const [, ext] = EXPORT_MAP[mimeType];
      if (!name.toLowerCase().endsWith(ext)) finalName = name + ext;
    }
    const storagePath = `${pathPrefix}${finalName}`;

    try {
      // Check if file exists and hasn't changed
      const folderPath = pathPrefix.replace(/\/$/, "") || undefined;
      const { data: existing } = await supabase.storage
        .from(BUCKET)
        .list(folderPath, { search: finalName, limit: 1 });

      if (existing?.length) {
        const match = existing.find((f) => f.name === finalName);
        if (match) {
          const driveMs = new Date(modifiedTime).getTime();
          const storageMs = new Date(
            match.updated_at || match.created_at
          ).getTime();
          if (driveMs <= storageMs + 60000) {
            stats.unchanged++;
            continue;
          }
        }
      }

      const { data, contentType } = await downloadFile(
        token,
        fileId,
        mimeType
      );
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, data, { contentType, upsert: true });

      if (error) {
        stats.failed++;
        stats.errors.push(`${storagePath}: ${error.message}`);
      } else {
        stats.uploaded++;
      }
    } catch (e: any) {
      stats.failed++;
      stats.errors.push(`${storagePath}: ${e.message?.substring(0, 100)}`);
    }
  }
}

// --- Route handler ---

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const start = Date.now();
  const stats: Stats = {
    uploaded: 0,
    unchanged: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  try {
    const token = await getAccessToken();
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    await syncFolder(token, supabase, ROOT_FOLDER_ID, "", stats);

    return NextResponse.json({
      success: true,
      stats,
      elapsed_seconds: +((Date.now() - start) / 1000).toFixed(1),
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message, stats },
      { status: 500 }
    );
  }
}
