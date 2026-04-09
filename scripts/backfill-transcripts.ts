/**
 * Backfill transcripts from Fathom API for sessions missing them
 *
 * Finds all sessions without a transcript record, fetches the full
 * transcript from the Fathom API, and creates Transcript records.
 *
 * Run: npx tsx scripts/backfill-transcripts.ts
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const FATHOM_API_KEY = process.env.COACHIQ_FATHOM_API_KEY!;
const FATHOM_API_BASE = "https://api.fathom.ai/external/v1";

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
  const dateStr = date
    ? date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "Unknown Date";

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

  // Find all sessions missing transcripts
  const sessionsWithoutTranscripts = await prisma.session.findMany({
    where: {
      transcript: null,
      fathomRecordingId: { not: null },
    },
    include: { client: true },
    orderBy: { date: "desc" },
  });

  console.log(`Found ${sessionsWithoutTranscripts.length} sessions missing transcripts`);

  if (sessionsWithoutTranscripts.length === 0) {
    console.log("Nothing to do.");
    await prisma.$disconnect();
    return;
  }

  // Build a set of recording IDs we need
  const neededRecordingIds = new Map(
    sessionsWithoutTranscripts.map((s) => [s.fathomRecordingId!, s])
  );

  // Fetch meetings from Fathom with transcripts, paginating through all
  let cursor: string | null = null;
  let fetched = 0;
  let created = 0;
  let notFound = 0;

  do {
    const params = new URLSearchParams({
      limit: "50",
      include_transcript: "true",
      include_summary: "true",
      include_action_items: "true",
    });
    if (cursor) params.set("cursor", cursor);

    const resp = await fetch(`${FATHOM_API_BASE}/meetings?${params}`, {
      headers: { "X-Api-Key": FATHOM_API_KEY },
    });

    if (!resp.ok) {
      if (resp.status >= 500) {
        console.warn(`Fathom API ${resp.status} — waiting 30s and retrying...`);
        await new Promise((r) => setTimeout(r, 30000));
        continue;
      }
      throw new Error(`Fathom API ${resp.status}: ${await resp.text()}`);
    }

    const data = (await resp.json()) as {
      items: FathomMeeting[];
      next_cursor?: string;
    };

    for (const meeting of data.items) {
      fetched++;
      const recordingId = String(meeting.recording_id);

      const session = neededRecordingIds.get(recordingId);
      if (!session) continue;

      // Got a match — create transcript
      if (meeting.transcript && meeting.transcript.length > 0) {
        const fullText = formatTranscript(
          meeting.title,
          session.client.name,
          session.date,
          meeting.transcript,
          meeting.default_summary,
          meeting.action_items,
          meeting.url
        );

        await prisma.transcript.create({
          data: {
            sessionId: session.id,
            clientId: session.clientId,
            fullText,
            rawSegments: meeting.transcript as unknown as undefined,
            wordCount: fullText.split(/\s+/).length,
          },
        });

        // Also update session with summary/action items if missing
        if (!session.fathomSummary && meeting.default_summary) {
          await prisma.session.update({
            where: { id: session.id },
            data: {
              fathomSummary:
                meeting.default_summary.markdown_formatted ||
                meeting.default_summary.text ||
                null,
              actionItems: meeting.action_items as unknown as undefined,
            },
          });
        }

        created++;
        neededRecordingIds.delete(recordingId);

        if (created % 25 === 0) {
          console.log(`  Created ${created} transcripts so far...`);
        }
      }

      // If we've found all we need, stop early
      if (neededRecordingIds.size === 0) break;
    }

    cursor = data.next_cursor || null;

    // Stop if we've found everything
    if (neededRecordingIds.size === 0) {
      console.log("All needed transcripts found — stopping pagination early.");
      break;
    }

    // Rate limit
    if (cursor) await new Promise((r) => setTimeout(r, 1500));

    if (fetched % 200 === 0) {
      console.log(`  Scanned ${fetched} meetings, created ${created} transcripts, ${neededRecordingIds.size} still needed...`);
    }
  } while (cursor);

  const totalTranscripts = await prisma.transcript.count();

  console.log(`\nTranscript backfill complete:`);
  console.log(`  Meetings scanned: ${fetched}`);
  console.log(`  Transcripts created: ${created}`);
  console.log(`  Still missing: ${neededRecordingIds.size}`);
  console.log(`  Total transcripts in DB: ${totalTranscripts}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
