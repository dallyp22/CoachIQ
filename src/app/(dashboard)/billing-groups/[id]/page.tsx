import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { GroupDetail } from "./group-detail";
import { requireCoachPage } from "@/lib/authz-page";
import { scopeCoachId, canAccess, clientWhere } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function BillingGroupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const coach = await requireCoachPage();
  const coachId = scopeCoachId(coach);

  const group = await prisma.billingGroup.findUnique({
    where: { id },
    include: {
      members: {
        select: {
          id: true,
          name: true,
          displayName: true,
          email: true,
          hourlyRate: true,
          status: true,
        },
        orderBy: { name: "asc" },
      },
      invoices: {
        orderBy: { createdAt: "desc" },
        take: 10,
      },
    },
  });
  if (!group || !canAccess(coachId, group.coachId)) notFound();

  // Available clients (not already in this group, status ACTIVE). Restricted
  // to the group's own coach: every member must share the group's coach.
  const availableClients = await prisma.client.findMany({
    where: { status: "ACTIVE", billingGroupId: null, ...clientWhere(group.coachId) },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  });

  return (
    <div>
      <div className="mb-6">
        <Link href="/billing-groups" className="text-sm text-muted hover:text-accent transition-colors">
          ← All groups
        </Link>
      </div>

      <GroupDetail
        group={{
          id: group.id,
          name: group.name,
          displayName: group.displayName,
          billingContactName: group.billingContactName,
          billingContactEmail: group.billingContactEmail,
          ccEmails: group.ccEmails,
          hourlyRate: group.hourlyRate ? Number(group.hourlyRate) : null,
          billingCadence: group.billingCadence,
          customCadenceDays: group.customCadenceDays,
          billingTimezone: group.billingTimezone,
          billingPausedUntil: group.billingPausedUntil
            ? group.billingPausedUntil.toISOString()
            : null,
          retainer: Number(group.retainer),
          stripeCustomerId: group.stripeCustomerId,
          notes: group.notes,
          status: group.status,
        }}
        members={group.members.map((m) => ({
          ...m,
          hourlyRate: Number(m.hourlyRate),
        }))}
        invoices={group.invoices.map((i) => ({
          id: i.id,
          invoiceNumber: i.invoiceNumber,
          status: i.status,
          total: Number(i.total),
          createdAt: i.createdAt.toISOString(),
        }))}
        availableClients={availableClients}
      />
    </div>
  );
}
