import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateSynopsis, getOpenAIKey } from "@/lib/ai";
import {
  ensureClientFolder,
  ensurePendingFolder,
  hasDriveCredentials,
  writeTranscript,
} from "@/lib/google-drive";
import {
  readSignatureHeaders,
  isTimestampFresh,
  recorderEmail,
} from "@/lib/fathom";
import { resolveWebhookCoach, describeFailure } from "@/lib/webhook-coach";
import { filterCoachingEvents } from "@/lib/google-calendar";

/**
 * Fathom Webhook Handler
 *
 * Pipeline:
 *   1. Identify the sending coach and authenticate against THEIR secret
 *   2. Idempotency check (recording_id)
 *   3. Calendar title filter (the coach's own pattern)
 *   4. Identify the client — within that coach's book only
 *   5. Calculate duration + billable minutes
 *   6. Create Session + Transcript in PostgreSQL
 *   7. Queue background jobs (embedding, synopsis)
 *
 * Every row this creates belongs to the coach resolved in step 1; an
 * unmatched invitee becomes a PendingRecording for them rather than a
 * console line.
 */
export async function POST(request: NextRequest) {
  const payload = await request.arrayBuffer();
  const payloadBytes = Buffer.from(payload);
  const body = JSON.parse(payloadBytes.toString());

  // 1. Identify and authenticate the sending coach.
  const sigHeaders = readSignatureHeaders(request.headers);
  if (!sigHeaders) {
    return NextResponse.json(
      { error: "Missing webhook verification headers" },
      { status: 401 }
    );
  }
  if (!isTimestampFresh(sigHeaders.timestamp)) {
    return NextResponse.json({ error: "Webhook timestamp too old or invalid" }, { status: 401 });
  }

  const outcome = await resolveWebhookCoach(
    payloadBytes,
    sigHeaders,
    recorderEmail(body)
  );
  if (!outcome.ok) {
    // Fathom stops retrying eventually, so a rejected payload is a permanently
    // lost recording. Never let that pass as a bare 401 nobody reads.
    console.error(`[fathom-webhook] ${describeFailure(outcome)}`);
    return NextResponse.json({ error: "Webhook signature verification failed" }, { status: 401 });
  }
  const coach = outcome.coach;

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

  // 3. Calendar title filter — the coach's own pattern, falling back to the
  //    practice default. Previously a hard-coded regex that ignored the
  //    configured setting entirely.
  const title = body.title || "";
  if (filterCoachingEvents([{ summary: title }], coach.coachingTitleFilter).length === 0) {
    return NextResponse.json({ status: "skipped", reason: "not a coaching session" });
  }

  // 4. Identify the client — within this coach's book only.
  //    is_external is computed by Fathom relative to the recorder's own email
  //    domain, so it stays correct per coach without extra handling.
  const coachAddresses = new Set(
    [coach.loginEmail, ...coach.workEmails].map((e) => e.toLowerCase())
  );
  const invitees: Array<{ email: string; name?: string; is_external?: boolean }> =
    body.calendar_invitees || [];
  const external = invitees.find(
    (inv) => inv.is_external && inv.email && !coachAddresses.has(inv.email.toLowerCase())
  );

  if (!external) {
    return NextResponse.json({ status: "skipped", reason: "no external invitee" });
  }

  const clientEmail = external.email.toLowerCase();
  const client = await prisma.client.findFirst({
    where: {
      coachId: coach.id,
      OR: [
        { email: clientEmail },
        { secondaryEmails: { has: clientEmail } },
      ],
    },
  });

  if (!client) {
    // Unknown client. The transcript still goes to Drive so it isn't lost,
    // but the reviewable record is a row: with per-coach Drive roots, an
    // owner would otherwise have to open each coach's Drive to find these.
    const pendingDate = body.recording_start_time
      ? new Date(body.recording_start_time)
      : new Date();
    let driveFileId: string | null = null;

    if (hasDriveCredentials()) {
      try {
        const pendingContent = formatTranscript(
          title,
          external.name || clientEmail,
          pendingDate,
          body.transcript || [],
          body.default_summary,
          body.action_items,
          body.url
        );
        const pendingFolder = await ensurePendingFolder(coach.driveRootFolderId);
        driveFileId = await writeTranscript({
          clientName: external.name || clientEmail,
          filename: `${external.name || clientEmail}_${recordingId}.txt`,
          content: pendingContent,
          folderId: pendingFolder,
        });
      } catch (driveErr) {
        console.error("Pending Drive write failed:", driveErr);
      }
    }

    // Idempotent: Fathom retries, and a retry must not stack duplicate rows.
    await prisma.pendingRecording.upsert({
      where: {
        coachId_fathomRecordingId: { coachId: coach.id, fathomRecordingId: recordingId },
      },
      update: { driveFileId },
      create: {
        coachId: coach.id,
        fathomRecordingId: recordingId,
        inviteeEmails: invitees.map((i) => i.email).filter(Boolean),
        driveFileId,
        title,
        recordedAt: pendingDate,
      },
    });

    console.warn(
      `[fathom-webhook] Unmatched recording for coach "${coach.name}": ` +
        `${external.name || clientEmail} <${clientEmail}> — "${title}". Awaiting review.`
    );

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

    return sess;
  });

  // 7. Save the formatted transcript to Drive under the client's folder.
  //    The DB row is the source of truth for the app; Drive is Todd's portable
  //    archive. A Drive failure must not fail the webhook — Fathom would retry
  //    and create no new value (idempotency on fathomRecordingId blocks the
  //    second attempt anyway). We log and leave transcriptDriveId null.
  const driveWork = (async () => {
    if (!hasDriveCredentials()) return;
    try {
      let folderId = client.driveFolderId;
      if (!folderId) {
        folderId = await ensureClientFolder(client.name, coach.driveRootFolderId);
        await prisma.client.update({
          where: { id: client.id },
          data: { driveFolderId: folderId },
        });
      }

      const dateStr = sessionDate.toISOString().slice(0, 10); // YYYY-MM-DD
      const filename = `${client.name}_${dateStr}_${recordingId}.txt`;
      const driveFileId = await writeTranscript({
        clientName: client.name,
        filename,
        content: fullText,
        folderId,
      });

      await prisma.session.update({
        where: { id: session.id },
        data: { transcriptDriveId: driveFileId },
      });
    } catch (e) {
      console.error("Drive write failed:", e);
    }
  })();

  // 8. Generate embedding + synopsis inline (non-blocking — respond first, then process)
  // Use waitUntil-style: fire and don't block the webhook response
  const aiWork = (async () => {
    if (transcriptData.length === 0) return;

    try {
      // Generate embedding
      const apiKey = await getOpenAIKey();
      const truncated = fullText.length > 20000 ? fullText.slice(0, 20000) : fullText;
      const embResp = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: truncated,
        }),
      });

      if (embResp.ok) {
        const embData = await embResp.json();
        const vectorStr = `[${embData.data[0].embedding.join(",")}]`;
        const transcript = await prisma.transcript.findFirst({
          where: { sessionId: session.id },
          select: { id: true },
        });
        if (transcript) {
          await prisma.$queryRawUnsafe(
            `UPDATE transcripts SET embedding = $1::vector, "embeddingModel" = $2 WHERE id = $3::uuid`,
            vectorStr,
            "text-embedding-3-small",
            transcript.id
          );
        }
      }
    } catch (e) {
      console.error("Embedding generation failed:", e);
    }

    try {
      // Get prior synopses for context
      const priorSessions = await prisma.session.findMany({
        where: {
          clientId: client.id,
          date: { lt: sessionDate },
          synopsis: { not: null },
        },
        orderBy: { date: "desc" },
        take: 3,
        select: { synopsis: true },
      });
      const priorSynopses = priorSessions.map((s) => s.synopsis!).reverse();

      const synopsis = await generateSynopsis(fullText, client.name, priorSynopses);
      await prisma.session.update({
        where: { id: session.id },
        data: { synopsis },
      });
    } catch (e) {
      console.error("Synopsis generation failed:", e);
    }
  })();

  // Wait for Drive + AI work to complete before responding (adds ~3-5s but ensures data is ready)
  await Promise.all([driveWork, aiWork]);

  return NextResponse.json({
    status: "processed",
    client: client.name,
    sessionId: session.id,
  });
}

// ─── HMAC Signature Verification ─────────────────────────────────

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
