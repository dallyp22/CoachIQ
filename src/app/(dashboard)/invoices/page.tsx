import { prisma } from "@/lib/db";
import { GenerateInvoicesButton, InvoiceCard } from "./actions";
import { detectDrift } from "@/lib/billing/snapshot";
import { requireCoachPage } from "@/lib/authz-page";
import { scopeCoachId, viaClientWhere, invoiceWhere } from "@/lib/authz";
import { coachesForFilter } from "@/lib/coaches";
import { CoachFilter } from "@/components/coach-filter";

export const dynamic = "force-dynamic";

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ coach?: string }>;
}) {
  const coach = await requireCoachPage();
  const params = await searchParams;
  const coachId = scopeCoachId(coach, params.coach ?? null);
  const coaches = await coachesForFilter(coach);
  // Column keys off role (attribution survives an inactive coach's history);
  // filter keys off the active roster (no point with one selectable coach).
  const isAdmin = coach.role !== "COACH";
  const showCoachControls = isAdmin && coaches.length > 1;

  // Get unbilled summary
  const unbilledEntries = await prisma.timeEntry.findMany({
    where: { status: "UNBILLED", ...viaClientWhere(coachId) },
    include: { client: { select: { name: true } } },
  });
  const unbilledTotal = unbilledEntries.reduce(
    (sum, e) => sum + Number(e.amount),
    0
  );
  const unbilledClients = new Set(unbilledEntries.map((e) => e.clientId)).size;

  // Get draft + approved invoices with full billable data so we can detect
  // snapshot drift. APPROVED invoices stay in the staging queue alongside
  // DRAFTs so the Send button remains reachable until the invoice is sent.
  const draftInvoices = await prisma.invoice.findMany({
    where: { status: { in: ["DRAFT", "APPROVED"] }, ...invoiceWhere(coachId) },
    include: {
      client: { include: { coach: { select: { name: true } } } },
      group: { include: { members: true, coach: { select: { name: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Get sent/paid/overdue invoices
  const invoiceHistory = await prisma.invoice.findMany({
    where: { status: { in: ["SENT", "PAID", "OVERDUE"] }, ...invoiceWhere(coachId) },
    include: {
      client: { select: { name: true, id: true, coach: { select: { name: true } } } },
      group: { select: { name: true, id: true, coach: { select: { name: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return (
    <div>
      <div className="flex items-baseline justify-between mb-8 gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-[32px] text-foreground">Invoices</h1>
          <p className="text-sm text-muted mt-1">
            Review, approve, and track coaching invoices
          </p>
        </div>
      </div>

      {showCoachControls && (
        <div className="mb-6">
          <CoachFilter coaches={coaches} selected={params.coach ?? null} basePath="/invoices" />
        </div>
      )}

      {/* Unbilled Alert */}
      {unbilledTotal > 0 && (
        <div className="bg-accent-light border border-accent/20 rounded-[var(--radius-md)] p-5 mb-8 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">
              {unbilledClients} client{unbilledClients !== 1 ? "s" : ""} with
              unbilled sessions
            </p>
            <p className="font-mono text-2xl font-medium text-accent mt-1">
              ${unbilledTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </p>
            <p className="text-xs text-muted mt-1">
              {unbilledEntries.length} sessions ready to invoice
            </p>
          </div>
          {/* Generation is practice-wide (see /api/invoices/generate), so it
              would contradict a coach-filtered view. Offer it only under
              "All coaches"; when filtered, show the scoped total without the
              button and point back to the practice-wide view. */}
          {params.coach ? (
            <p className="text-xs text-muted max-w-[13rem] text-right leading-relaxed">
              Generating drafts runs across all coaches — switch to{" "}
              <span className="text-foreground">All coaches</span> to generate.
            </p>
          ) : (
            <GenerateInvoicesButton />
          )}
        </div>
      )}

      {/* Draft Invoices (Staging Queue) */}
      {draftInvoices.length > 0 && (
        <div className="mb-10">
          <h2 className="font-display text-xl text-foreground mb-4">
            Awaiting Review
          </h2>
          <div className="space-y-3">
            {draftInvoices.map((invoice) => {
              const billable = invoice.group
                ? { kind: "group" as const, group: invoice.group, members: invoice.group.members }
                : invoice.client
                  ? { kind: "client" as const, client: invoice.client }
                  : null;
              const driftedFields = billable ? detectDrift(invoice, billable) : [];
              const billableName = invoice.group
                ? invoice.group.name
                : invoice.client?.name ?? "Unknown";
              const billableId = invoice.group?.id ?? invoice.client?.id ?? "";
              // Attribution on the actionable card: without it an admin can't
              // tell two coaches' same-named clients apart before approving/sending.
              const coachName = invoice.group?.coach?.name ?? invoice.client?.coach?.name ?? null;
              return (
                <InvoiceCard
                  key={invoice.id}
                  coachName={isAdmin ? coachName : null}
                  invoice={{
                    id: invoice.id,
                    invoiceNumber: invoice.invoiceNumber,
                    periodStart: invoice.periodStart.toISOString(),
                    periodEnd: invoice.periodEnd.toISOString(),
                    lineItems: invoice.lineItems as Array<{
                      date: string;
                      description: string;
                      hours: number;
                      rate: number;
                      amount: number;
                    }>,
                    total: Number(invoice.total),
                    notes: invoice.notes,
                    createdAt: invoice.createdAt.toISOString(),
                    status: invoice.status,
                  }}
                  clientName={invoice.snapshotClientName ?? billableName}
                  clientId={billableId}
                  snapshot={{
                    snapshotClientName: invoice.snapshotClientName,
                    snapshotBillingEmail: invoice.snapshotBillingEmail,
                    snapshotBillingCcEmails: invoice.snapshotBillingCcEmails,
                    driftedFields,
                  }}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Invoice History */}
      <div>
        <h2 className="font-display text-xl text-foreground mb-4">
          Invoice History
        </h2>
        {invoiceHistory.length === 0 && draftInvoices.length === 0 ? (
          <div className="text-center py-12">
            <p className="font-display text-lg text-foreground">
              All caught up
            </p>
            <p className="text-sm text-muted mt-2">
              No invoices to review. Generate drafts from unbilled sessions above.
            </p>
          </div>
        ) : invoiceHistory.length === 0 ? (
          <p className="text-sm text-muted">
            No sent invoices yet. Approve drafts above to get started.
          </p>
        ) : (
          <div className="bg-surface border border-border rounded-[var(--radius-lg)] overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium">
                    Invoice
                  </th>
                  <th className="text-left px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium">
                    Client
                  </th>
                  {isAdmin && (
                    <th className="text-left px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium hidden md:table-cell">
                      Coach
                    </th>
                  )}
                  <th className="text-left px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium">
                    Status
                  </th>
                  <th className="text-right px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {invoiceHistory.map((inv) => (
                  <tr
                    key={inv.id}
                    className="border-b border-border last:border-b-0"
                  >
                    <td className="px-5 py-3 font-mono text-sm text-muted">
                      {inv.invoiceNumber}
                    </td>
                    <td className="px-5 py-3 text-sm text-foreground">
                      {inv.group?.name ?? inv.client?.name ?? "—"}
                    </td>
                    {isAdmin && (
                      <td className="px-5 py-3 text-sm text-muted hidden md:table-cell">
                        {inv.group?.coach?.name ?? inv.client?.coach?.name ?? "—"}
                      </td>
                    )}
                    <td className="px-5 py-3">
                      <InvoiceStatusBadge status={inv.status} />
                    </td>
                    <td className="px-5 py-3 font-mono text-sm text-foreground text-right">
                      ${Number(inv.total).toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Semantic tokens, not fixed hexes — these shift with the theme. SENT uses
 * the accent because an invoice awaiting payment is a state to notice, not a
 * warning; DRAFT and VOID stay neutral.
 */
function InvoiceStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    DRAFT: "bg-border/40 text-muted border-border",
    APPROVED: "bg-info/10 text-info border-info/25",
    SENT: "bg-accent/10 text-accent border-accent/25",
    PAID: "bg-success/10 text-success border-success/25",
    OVERDUE: "bg-error/10 text-error border-error/25",
    VOID: "bg-border/40 text-muted border-border",
  };

  return (
    <span
      className={`inline-block px-2 py-0.5 text-xs font-medium rounded border ${
        styles[status] || styles.DRAFT
      }`}
    >
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}
