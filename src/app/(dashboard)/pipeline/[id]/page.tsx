import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireCoachPage } from "@/lib/authz-page";
import { scopeCoachId, canAccessProspect } from "@/lib/authz";
import { liveStages } from "@/lib/pipeline/stages";
import { ProspectDossier } from "./dossier";

export const dynamic = "force-dynamic";

/**
 * Prospect dossier (PRD §6.3) — identity on the left, the activity log on the
 * right, mirroring the client dossier so the two feel like one product.
 */
export default async function ProspectPage({ params }: { params: Promise<{ id: string }> }) {
  const coach = await requireCoachPage();
  const coachId = scopeCoachId(coach);
  const { id } = await params;

  const prospect = await prisma.prospect.findUnique({
    where: { id },
    select: {
      id: true,
      coachId: true,
      assignedCoachId: true,
      firstName: true,
      lastName: true,
      company: true,
      opportunityType: true,
      needSummary: true,
      email: true,
      phone: true,
      notes: true,
      source: true,
      stageId: true,
      stageEnteredAt: true,
      nextActivityAt: true,
      lostReason: true,
      convertedToClientId: true,
      createdAt: true,
      stage: { select: { id: true, name: true, terminal: true, isHot: true } },
      coach: { select: { id: true, name: true } },
      assignedCoach: { select: { id: true, name: true } },
    },
  });

  // 404 rather than 403 — confirming a prospect exists but belongs to someone
  // else is itself a disclosure.
  if (!prospect || !canAccessProspect(coachId, prospect)) notFound();

  const [activities, stageChanges, stages, coaches, convertedClient] = await Promise.all([
    prisma.pipelineActivity.findMany({
      where: { prospectId: id },
      orderBy: { activityAt: "desc" },
      select: {
        id: true,
        kind: true,
        activityAt: true,
        notes: true,
        completedAt: true,
        owner: { select: { id: true, name: true } },
      },
    }),
    prisma.prospectStageChange.findMany({
      where: { prospectId: id },
      orderBy: { changedAt: "desc" },
      select: { id: true, fromStageId: true, toStageId: true, changedAt: true },
    }),
    liveStages(),
    coach.role === "COACH"
      ? Promise.resolve([{ id: coach.id, name: coach.name }])
      : prisma.coach.findMany({
          where: { status: { not: "INACTIVE" } },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        }),
    prospect.convertedToClientId
      ? prisma.client.findUnique({
          where: { id: prospect.convertedToClientId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
  ]);

  const stageNames = new Map(stages.map((s) => [s.id, s.name]));
  // Archived stages still hold history, so resolve names from the full set.
  const allStages = await prisma.pipelineStage.findMany({ select: { id: true, name: true } });
  for (const s of allStages) stageNames.set(s.id, s.name);

  return (
    <div>
      <Link
        href="/pipeline"
        className="text-sm text-muted hover:text-foreground transition-colors inline-flex items-center gap-1.5 mb-4"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
        </svg>
        Pipeline
      </Link>

      <ProspectDossier
        prospect={{
          ...prospect,
          stageEnteredAt: prospect.stageEnteredAt.toISOString(),
          nextActivityAt: prospect.nextActivityAt?.toISOString() ?? null,
          createdAt: prospect.createdAt.toISOString(),
        }}
        activities={activities.map((a) => ({
          ...a,
          activityAt: a.activityAt.toISOString(),
          completedAt: a.completedAt?.toISOString() ?? null,
        }))}
        stageChanges={stageChanges.map((c) => ({
          id: c.id,
          changedAt: c.changedAt.toISOString(),
          from: c.fromStageId ? (stageNames.get(c.fromStageId) ?? null) : null,
          to: stageNames.get(c.toStageId) ?? "Unknown stage",
        }))}
        stages={stages}
        coaches={coaches}
        convertedClient={convertedClient}
        canEdit={canAccessProspect(coachId, prospect)}
      />
    </div>
  );
}
