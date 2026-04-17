import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { ClientDossier } from "./client-dossier";

export default async function ClientDossierPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const client = await prisma.client.findUnique({
    where: { id },
    include: {
      sessions: {
        orderBy: { date: "desc" },
        take: 20,
      },
    },
  });

  if (!client) notFound();

  return (
    <ClientDossier
      client={{
        id: client.id,
        name: client.name,
        displayName: client.displayName,
        email: client.email,
        phone: client.phone,
        company: client.company,
        hourlyRate: Number(client.hourlyRate),
        billingCadence: client.billingCadence,
        customCadenceDays: client.customCadenceDays,
        billingContactName: client.billingContactName,
        billingContactEmail: client.billingContactEmail,
        secondaryEmails: client.secondaryEmails,
        billingPausedUntil: client.billingPausedUntil
          ? client.billingPausedUntil.toISOString()
          : null,
        billingNotes: client.billingNotes,
        retainer: Number(client.retainer),
        meetingCadence: client.meetingCadence,
        allowsFathom: client.allowsFathom,
        status: client.status,
        notes: client.notes,
        tags: client.tags,
        sessionCount: client.sessionCount,
        notebookId: client.notebookId,
        driveFolderId: client.driveFolderId,
        sessions: client.sessions.map((s) => ({
          id: s.id,
          title: s.title,
          date: s.date.toISOString(),
          durationMinutes: s.durationMinutes,
          billableMinutes: s.billableMinutes,
          recordingUrl: s.recordingUrl,
          synopsis: s.synopsis,
          sessionSource: s.sessionSource,
        })),
      }}
    />
  );
}
