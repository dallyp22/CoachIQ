import { google, drive_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import fs from "fs";

const ROOT_FOLDER_NAME =
  process.env.COACHIQ_DRIVE_ROOT_FOLDER_NAME || "CoachIQ";
const PENDING_FOLDER_NAME = "_Pending Review";

interface DriveToken {
  token: string;
  refresh_token: string;
  token_uri: string;
  client_id: string;
  client_secret: string;
  scopes: string[];
}

let _drive: drive_v3.Drive | null = null;
let _rootFolderId: string | null = null;
const _clientFolderCache = new Map<string, string>();

function loadToken(): DriveToken {
  const blob = process.env.COACHIQ_DRIVE_TOKEN_JSON;
  if (blob) return JSON.parse(blob) as DriveToken;

  const filePath = process.env.COACHIQ_DRIVE_TOKEN_PATH;
  if (filePath) {
    const resolved = filePath.startsWith("/")
      ? filePath
      : `${process.cwd()}/${filePath}`;
    return JSON.parse(fs.readFileSync(resolved, "utf-8")) as DriveToken;
  }

  throw new Error(
    "Drive token not configured. Set COACHIQ_DRIVE_TOKEN_JSON (JSON blob, recommended for Vercel) or COACHIQ_DRIVE_TOKEN_PATH (local file)."
  );
}

export function hasDriveCredentials(): boolean {
  return !!(
    process.env.COACHIQ_DRIVE_TOKEN_JSON || process.env.COACHIQ_DRIVE_TOKEN_PATH
  );
}

export function getDrive(): drive_v3.Drive {
  if (_drive) return _drive;

  const tok = loadToken();
  const oauth2 = new OAuth2Client({
    clientId: tok.client_id,
    clientSecret: tok.client_secret,
  });
  oauth2.setCredentials({
    access_token: tok.token,
    refresh_token: tok.refresh_token,
    scope: tok.scopes.join(" "),
  });
  // The OAuth2Client refreshes the access token automatically when it expires
  // using the refresh_token. We don't persist the new access token (Vercel is
  // stateless); the in-memory client handles it for the lifetime of the process.

  _drive = google.drive({ version: "v3", auth: oauth2 });
  return _drive;
}

function escapeDriveQueryLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findOrCreateFolder(
  name: string,
  parentId: string | null
): Promise<string> {
  const drive = getDrive();
  const safeName = escapeDriveQueryLiteral(name);
  const parts = [
    `name = '${safeName}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    `trashed = false`,
  ];
  if (parentId) parts.push(`'${parentId}' in parents`);

  const res = await drive.files.list({
    q: parts.join(" and "),
    fields: "files(id)",
    spaces: "drive",
    pageSize: 1,
  });

  const existing = res.data.files?.[0]?.id;
  if (existing) return existing;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: "id",
  });

  if (!created.data.id) {
    throw new Error(`Drive folder create returned no id for "${name}"`);
  }
  return created.data.id;
}

async function getRootFolderId(): Promise<string> {
  if (_rootFolderId) return _rootFolderId;

  // Prefer a pinned ID. Drive's search index is eventually consistent, so
  // looking up by name from a cold serverless function can miss an existing
  // folder and create a duplicate. A pinned ID skips the search entirely.
  const pinned = process.env.COACHIQ_DRIVE_ROOT_FOLDER_ID?.trim();
  if (pinned) {
    _rootFolderId = pinned;
    return _rootFolderId;
  }

  _rootFolderId = await findOrCreateFolder(ROOT_FOLDER_NAME, null);
  return _rootFolderId;
}

/**
 * Resolve a client's transcript folder under the owning coach's Drive root.
 *
 * `coachRootFolderId` is the folder in that coach's OWN Drive, shared with
 * the app's Drive identity. Falls back to the practice-wide root for coaches
 * who have not set one. The cache is keyed by root AND name — keying by name
 * alone would hand two coaches with a same-named client the same folder.
 */
export async function ensureClientFolder(
  clientName: string,
  coachRootFolderId?: string | null
): Promise<string> {
  const root = coachRootFolderId || (await getRootFolderId());
  const cacheKey = `${root}:${clientName}`;
  const cached = _clientFolderCache.get(cacheKey);
  if (cached) return cached;

  const folderId = await findOrCreateFolder(clientName, root);
  _clientFolderCache.set(cacheKey, folderId);
  return folderId;
}

export async function ensurePendingFolder(
  coachRootFolderId?: string | null
): Promise<string> {
  return ensureClientFolder(PENDING_FOLDER_NAME, coachRootFolderId);
}

interface WriteTranscriptArgs {
  clientName: string;
  filename: string;
  content: string;
  folderId?: string | null;
}

export async function writeTranscript({
  clientName,
  filename,
  content,
  folderId,
}: WriteTranscriptArgs): Promise<string> {
  const drive = getDrive();
  const targetFolder = folderId ?? (await ensureClientFolder(clientName));

  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await drive.files.create({
        requestBody: {
          name: filename,
          parents: [targetFolder],
          mimeType: "text/plain",
        },
        media: {
          mimeType: "text/plain",
          body: content,
        },
        fields: "id",
      });
      if (!res.data.id) {
        throw new Error(`Drive file create returned no id for ${filename}`);
      }
      return res.data.id;
    } catch (err) {
      lastErr = err;
      const status = (err as { code?: number; response?: { status?: number } })
        ?.response?.status ??
        (err as { code?: number })?.code;
      const retryable = status === 429 || (status && status >= 500);
      if (!retryable || attempt === maxAttempts) break;
      const waitMs = attempt * 5000;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Drive write failed for ${filename}`);
}
