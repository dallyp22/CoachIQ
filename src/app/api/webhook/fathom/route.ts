import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import crypto from "crypto";

const WEBHOOK_SECRET = process.env.COACHIQ_FATHOM_WEBHOOK_SECRET || "";
const COACH_EMAIL = (process.env.COACHIQ_COACH_EMAIL || "todd@growwithcocreate.com").toLowerCase();
const COACHING_FILTER = /coaching|executive coaching|session/i;
const TIMESTAMP_TOLERANCE = 300; // seconds

/**
 * Fathom Webhook Handler (TypeScript port)
 *
 * Pipeline:
 *   1. Verify HMAC-SHA256 signature
 *   2. Idempotency check (recording_id)
 *   3. Calendar title filter
 *   4. Identify client by email
 *   5. Calculate duration + billable minutes
 *   6. Create Session + Transcript in PostgreSQL
 *   7. Queue background jobs (embedding, synopsis)
 */
export async function POST(request: NextRequest) {
  const payload = await request.arrayBuffer();
  const payloadBytes = Buffer.from(payload);
  const body = JSON.parse(payloadBytes.toString());

  // 1. Verify HMAC signature
  const webhookId = request.headers.get("webhook-id") || "";
  const timestamp = request.headers.get("webhook-timestamp") || "";
  const signature = request.headers.get("webhook-signature") || "";

  if (!webhookId || !timestamp || !signature) {
    return NextResponse.json(
      { error: "Missing webhook verification headers" },
      { status: 401 }
    );
  }

  const sigError = verifySignature(payloadBytes, webhookId, timestamp, signature);
  if (sigError) {
    return NextResponse.json({ error: sigError }, { status: 401 });
  }

  // 2. Idempotency check
  const recordingId = String(body.recording_id || "");
  if (!recordingId) {
    return NextResponse.json({ error: "Missing recording_id" }, { status: 400 });
  }

  const existing = await prisma.session.findUnique({
    where: { fathomRecordingId: recordingId },
  });
  if (existing) {
    return NextResponse.json({ status: "duplicate", recordingId });
  }

  // 3. Calendar title filter
  const title = body.title || "";
  if (!COACHING_FILTER.test(title)) {
    return NextResponse.json({ status: "skipped", reason: "not a coaching session" });
  }

  // 4. Identify client
  const invitees: Array<{ email: string; name?: string; is_external?: boolean }> =
    body.calendar_invitees || [];
  const external = invitees.find(
    (inv) => inv.is_external && inv.email?.toLowerCase() !== COACH_EMAIL
  );

  if (!external) {
    return NextResponse.json({ status: "skipped", reason: "no external invitee" });
  }

  const clientEmail = external.email.toLowerCase();
  const client = await prisma.client.findFirst({
    where: {
      OR: [
        { email: clientEmail },
        { secondaryEmails: { has: clientEmail } },
      ],
    },
  });

  if (!client) {
    // Unknown client — log for review
    console.warn(`Unknown client: ${external.name} (${clientEmail}) — ${title}`);
    return NextResponse.json({
      status: "pending_review",
      name: external.name || clientEmail,
      email: clientEmail,
    });
  }

  // 5. Calculate duration and billable minutes
  let durationMinutes = 0;
  if (body.recording_start_time && body.recording_end_time) {
    const start = new Date(body.recording_start_time);
    const end = new Date(body.recording_end_time);
    durationMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
  }
  const billableMinutes = Math.ceil(durationMinutes / 15) * 15;

  const sessionDate = body.recording_start_time
    ? new Date(body.recording_start_time)
    : new Date();

  // Format transcript text
  const transcriptData: Array<{ speaker?: { display_name?: string }; timestamp?: string; text?: string }> =
    body.transcript || [];
  const fullText = formatTranscript(
    title,
    client.name,
    sessionDate,
    transcriptData,
    body.default_summary,
    body.action_items,
    body.url
  );

  // 6. Create Session + Transcript + Queue jobs in transaction
  const session = await prisma.$transaction(async (tx) => {
    const sess = await tx.session.create({
      data: {
        clientId: client.id,
        fathomRecordingId: recordingId,
        sessionSource: "FATHOM",
        title,
        date: sessionDate,
        durationMinutes,
        billableMinutes,
        recordingUrl: body.url || null,
        shareUrl: body.share_url || null,
        fathomSummary:
          body.default_summary?.markdown_formatted ||
          body.default_summary?.text ||
          null,
        actionItems: body.action_items || undefined,
        status: "CAPTURED",
      },
    });

    // Create transcript if we have content
    if (transcriptData.length > 0) {
      await tx.transcript.create({
        data: {
          sessionId: sess.id,
          clientId: client.id,
          fullText,
          rawSegments: transcriptData as unknown as undefined,
          wordCount: fullText.split(/\s+/).length,
        },
      });
    }

    // Increment session count atomically
    await tx.client.update({
      where: { id: client.id },
      data: { sessionCount: { increment: 1 } },
    });

    // Auto-generate TimeEntry
    const billableHrs = Math.ceil(durationMinutes / 15) * 0.25;
    const hourlyRate = Number(client.hourlyRate);
    await tx.timeEntry.create({
      data: {
        sessionId: sess.id,
        clientId: client.id,
        date: sessionDate,
        description: title,
        billableHours: billableHrs,
        hourlyRate,
        amount: billableHrs * hourlyRate,
        isManual: false,
        status: "UNBILLED",
      },
    });

    // 7. Queue background jobs
    if (transcriptData.length > 0) {
      await tx.job.create({
        data: {
          type: "GENERATE_EMBEDDING",
          payload: { sessionId: sess.id, clientId: client.id },
        },
      });

      await tx.job.create({
        data: {
          type: "GENERATE_SYNOPSIS",
          payload: { sessionId: sess.id, clientId: client.id },
        },
      });
    }

    return sess;
  });

  return NextResponse.json({
    status: "processed",
    client: client.name,
    sessionId: session.id,
  });
}

// ─── HMAC Signature Verification ─────────────────────────────────

function verifySignature(
  payload: Buffer,
  webhookId: string,
  timestamp: string,
  signature: string
): string | null {
  // Replay protection
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > TIMESTAMP_TOLERANCE) {
    return "Webhook timestamp too old or invalid";
  }

  // Construct signed content: "webhook_id.timestamp.body"
  const signedContent = Buffer.concat([
    Buffer.from(`${webhookId}.${timestamp}.`),
    payload,
  ]);

  // Decode secret (strip "whsec_" prefix)
  let secretKey = WEBHOOK_SECRET;
  if (secretKey.startsWith("whsec_")) {
    secretKey = secretKey.slice(6);
  }
  const secretBytes = Buffer.from(secretKey, "base64");

  // Compute expected HMAC-SHA256
  const expected = crypto
    .createHmac("sha256", secretBytes)
    .update(signedContent)
    .digest("base64");

  // Compare against provided signatures (may be space-separated with version prefix)
  const providedSigs = signature.split(" ");
  for (const sig of providedSigs) {
    const parts = sig.split(",");
    const sigValue = parts[parts.length - 1];
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigValue))) {
      return null; // Valid
    }
  }

  return "Webhook signature verification failed";
}

// ─── Transcript Formatting ───────────────────────────────────────

function formatTranscript(
  title: string,
  clientName: string,
  date: Date | null,
  transcript: Array<{ speaker?: { display_name?: string }; timestamp?: string; text?: string }>,
  summary?: { markdown_formatted?: string; text?: string } | null,
  actionItems?: Array<{ assignee_name?: string; description?: string }> | null,
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
