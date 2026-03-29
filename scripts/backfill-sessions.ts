/**
 * Backfill sessions from Fathom API → Neon PostgreSQL
 *
 * Fetches all meetings from Fathom, matches to clients by email,
 * creates Session + Transcript records. Updates client sessionCount.
 *
 * Run: npx tsx scripts/backfill-sessions.ts
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const FATHOM_API_KEY = process.env.COACHIQ_FATHOM_API_KEY!;
const FATHOM_API_BASE = "https://api.fathom.ai/external/v1";
const COACH_EMAIL = process.env.COACHIQ_COACH_EMAIL || "todd@growwithcocreate.com";
const COACHING_FILTER = /coaching|executive coaching|session/i;

interface FathomMeeting {
  recording_id: number;
  title: string;
  url?: string;
  share_url?: string;
  recording_start_time?: string;
  recording_end_time?: string;
  calendar_invitees?: Array<{
    email: string;
    name?: string;
    is_external?: boolean;
  }>;
  default_summary?: { markdown_formatted?: string; text?: string } | null;
  action_items?: Array<{ assignee_name?: string; description?: string }> | null;
  transcript?: Array<{
    speaker?: { display_name?: string };
    timestamp?: string;
    text?: string;
  }> | null;
}

async function fathomGet(endpoint: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`${FATHOM_API_BASE}/${endpoint}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString(), {
    headers: { "X-Api-Key": FATHOM_API_KEY },
  });
  if (!resp.ok) {
    if (resp.status >= 500) {
      console.warn(`Fathom API ${resp.status} — waiting 30s and retrying...`);
      await new Promise((r) => setTimeout(r, 30000));
      const retry = await fetch(url.toString(), {
        headers: { "X-Api-Key": FATHOM_API_KEY },
      });
      if (!retry.ok) throw new Error(`Fathom API ${retry.status} after retry`);
      return retry.json();
    }
    throw new Error(`Fathom API ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

function formatTranscript(
  title: string,
  clientName: string,
  date: Date | null,
  transcript: FathomMeeting["transcript"],
  summary: FathomMeeting["default_summary"],
  actionItems: FathomMeeting["action_items"],
  recordingUrl?: string
): string {
  const lines: string[] = [];
  const dateStr = date ? date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "Unknown Date";

  lines.push("COACHING SESSION TRANSCRIPT");
  lines.push(`Client: ${clientName}`);
  lines.push(`Date: ${dateStr}`);
  lines.push(`Title: ${title}`);
  if (recordingUrl) lines.push(`Recording: ${recordingUrl}`);
  lines.push("");

  if (summary) {
    const md = summary.markdown_formatted || summary.text || "";
    if (md) {
      lines.push("--- SESSION SUMMARY ---");
      lines.push(md.trim());
      lines.push("");
    }
  }

  if (actionItems?.length) {
    lines.push("--- ACTION ITEMS ---");
    for (const item of actionItems) {
      lines.push(`- [${item.assignee_name || "Unassigned"}] ${item.description || ""}`);
    }
    lines.push("");
  }

  if (transcript?.length) {
    lines.push("--- FULL TRANSCRIPT ---");
    for (const entry of transcript) {
      const speaker = entry.speaker?.display_name || "Unknown";
      const text = entry.text || "";
      if (text.trim()) {
        lines.push(`[${entry.timestamp || ""}] ${speaker}: ${text}`);
      }
    }
  }

  return lines.join("\n");
}

async function main() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });

  // Build email → client lookup
  const clients = await prisma.client.findMany();
  const clientByEmail = new Map<string, (typeof clients)[0]>();
  for (const c of clients) {
    clientByEmail.set(c.email.toLowerCase(), c);
    for (const se of c.secondaryEmails) {
      clientByEmail.set(se.toLowerCase(), c);
    }
  }
  console.log(`Loaded ${clients.length} clients for matching`);

  // Fetch all meetings from Fathom
  let cursor: string | null = null;
  let totalFetched = 0;
  let matched = 0;
  let created = 0;
  let skipped = 0;

  do {
    const params: Record<string, string> = { limit: "50" };
    if (cursor) params.cursor = cursor;

    const data = (await fathomGet("meetings", params)) as {
      items: FathomMeeting[];
      next_cursor?: string;
    };

    for (const meeting of data.items) {
      totalFetched++;

      // Filter for coaching sessions
      if (!COACHING_FILTER.test(meeting.title || "")) continue;

      // Find the client (external invitee)
      const invitees = meeting.calendar_invitees || [];
      const external = invitees.find(
        (inv) => inv.is_external && inv.email?.toLowerCase() !== COACH_EMAIL.toLowerCase()
      );
      if (!external) continue;

      const client = clientByEmail.get(external.email.toLowerCase());
      if (!client) continue;
      matched++;

      const recordingId = String(meeting.recording_id);

      // Check if session already exists (idempotency)
      const existing = await prisma.session.findUnique({
        where: { fathomRecordingId: recordingId },
      });
      if (existing) {
        skipped++;
        continue;
      }

      // Calculate duration and billable minutes
      let durationMinutes = 0;
      if (meeting.recording_start_time && meeting.recording_end_time) {
        const start = new Date(meeting.recording_start_time);
        const end = new Date(meeting.recording_end_time);
        durationMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
      }
      const billableMinutes = Math.ceil(durationMinutes / 15) * 15;

      const sessionDate = meeting.recording_start_time
        ? new Date(meeting.recording_start_time)
        : new Date();

      // Create session (transcript may be null from list endpoint — backfill transcripts separately)
      await prisma.$transaction(async (tx) => {
        const session = await tx.session.create({
          data: {
            clientId: client.id,
            fathomRecordingId: recordingId,
            title: meeting.title,
            date: sessionDate,
            durationMinutes,
            billableMinutes,
            recordingUrl: meeting.url || null,
            shareUrl: meeting.share_url || null,
            fathomSummary: meeting.default_summary?.markdown_formatted || meeting.default_summary?.text || null,
            actionItems: meeting.action_items as unknown as undefined,
            status: "CAPTURED",
          },
        });

        // Create transcript if available (usually null from list endpoint)
        if (meeting.transcript && meeting.transcript.length > 0) {
          const fullText = formatTranscript(
            meeting.title,
            client.name,
            sessionDate,
            meeting.transcript,
            meeting.default_summary,
            meeting.action_items,
            meeting.url
          );
          await tx.transcript.create({
            data: {
              sessionId: session.id,
              clientId: client.id,
              fullText,
              rawSegments: meeting.transcript as unknown as undefined,
              wordCount: fullText.split(/\s+/).length,
            },
          });
        }

        // Increment session count
        await tx.client.update({
          where: { id: client.id },
          data: { sessionCount: { increment: 1 } },
        });
      });

      created++;
      if (created % 25 === 0) {
        console.log(`  Created ${created} sessions so far...`);
      }
    }

    cursor = data.next_cursor || null;

    // Rate limit: Fathom API
    if (cursor) await new Promise((r) => setTimeout(r, 1500));
  } while (cursor);

  console.log(`\nBackfill complete:`);
  console.log(`  Total meetings fetched: ${totalFetched}`);
  console.log(`  Matched to clients: ${matched}`);
  console.log(`  Sessions created: ${created}`);
  console.log(`  Skipped (already exist): ${skipped}`);

  // Print per-client summary
  const updatedClients = await prisma.client.findMany({
    where: { sessionCount: { gt: 0 } },
    orderBy: { sessionCount: "desc" },
    take: 10,
  });
  console.log(`\nTop 10 clients by session count:`);
  for (const c of updatedClients) {
    console.log(`  ${c.name}: ${c.sessionCount} sessions`);
  }

  const totalSessions = await prisma.session.count();
  const totalTranscripts = await prisma.transcript.count();
  console.log(`\nDatabase totals: ${totalSessions} sessions, ${totalTranscripts} transcripts`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
