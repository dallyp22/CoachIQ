import Link from "next/link";
import { prisma } from "@/lib/db";
import { CreateGroupButton } from "./actions";
import { requireCoachPage } from "@/lib/authz-page";
import { scopeCoachId } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function BillingGroupsPage() {
  const coach = await requireCoachPage();
  const coachId = scopeCoachId(coach);

  const groups = await prisma.billingGroup.findMany({
    where: coachId ? { coachId } : {},
    orderBy: { name: "asc" },
    include: {
      _count: { select: { members: true, invoices: true } },
    },
  });

  return (
    <div>
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h1 className="font-display text-[32px] text-foreground">Billing Groups</h1>
          <p className="text-sm text-muted mt-1">
            One invoice per organization, even when you coach multiple people there.
          </p>
        </div>
        <CreateGroupButton />
      </div>

      {groups.length === 0 ? (
        <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-10 text-center">
          <p className="font-display text-lg text-foreground">No groups yet</p>
          <p className="text-sm text-muted mt-2 max-w-md mx-auto">
            Create a group when one client (e.g. Acme Corp) covers coaching for
            multiple people. The group gets one billing contact, one Stripe
            customer, and one invoice covering every member's hours.
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-[var(--radius-lg)] overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium">Name</th>
                <th className="text-left px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium">Contact</th>
                <th className="text-left px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium">Cadence</th>
                <th className="text-right px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium">Members</th>
                <th className="text-right px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium">Invoices</th>
                <th className="text-right px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium">Retainer</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id} className="border-b border-border last:border-b-0 hover:bg-background/40">
                  <td className="px-5 py-3 text-sm text-foreground">
                    <Link href={`/billing-groups/${g.id}`} className="hover:text-accent transition-colors">
                      {g.displayName ?? g.name}
                    </Link>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-muted">
                    {g.billingContactEmail}
                  </td>
                  <td className="px-5 py-3 text-sm text-muted">
                    {g.billingCadence.charAt(0) + g.billingCadence.slice(1).toLowerCase()}
                  </td>
                  <td className="px-5 py-3 font-mono text-sm text-foreground text-right">
                    {g._count.members}
                  </td>
                  <td className="px-5 py-3 font-mono text-sm text-muted text-right">
                    {g._count.invoices}
                  </td>
                  <td className="px-5 py-3 font-mono text-sm text-foreground text-right">
                    ${Number(g.retainer).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
