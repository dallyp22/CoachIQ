import { prisma } from "@/lib/db";
import Link from "next/link";
import { GenerateInvoicesButton, InvoiceCard } from "./actions";

export const dynamic = "force-dynamic";

export default async function InvoicesPage() {
  // Get unbilled summary
  const unbilledEntries = await prisma.timeEntry.findMany({
    where: { status: "UNBILLED" },
    include: { client: { select: { name: true } } },
  });
  const unbilledTotal = unbilledEntries.reduce(
    (sum, e) => sum + Number(e.amount),
    0
  );
  const unbilledClients = new Set(unbilledEntries.map((e) => e.clientId)).size;

  // Get draft invoices
  const draftInvoices = await prisma.invoice.findMany({
    where: { status: "DRAFT" },
    include: { client: { select: { name: true, id: true } } },
    orderBy: { createdAt: "desc" },
  });

  // Get sent/paid/overdue invoices
  const invoiceHistory = await prisma.invoice.findMany({
    where: { status: { in: ["SENT", "PAID", "OVERDUE", "APPROVED"] } },
    include: { client: { select: { name: true, id: true } } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return (
    <div>
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h1 className="font-display text-[32px] text-foreground">Invoices</h1>
          <p className="text-sm text-muted mt-1">
            Review, approve, and track coaching invoices
          </p>
        </div>
      </div>

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
          <GenerateInvoicesButton />
        </div>
      )}

      {/* Draft Invoices (Staging Queue) */}
      {draftInvoices.length > 0 && (
        <div className="mb-10">
          <h2 className="font-display text-xl text-foreground mb-4">
            Awaiting Review
          </h2>
          <div className="space-y-3">
            {draftInvoices.map((invoice) => (
              <InvoiceCard
                key={invoice.id}
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
                }}
                clientName={invoice.client.name}
                clientId={invoice.client.id}
              />
            ))}
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
                      {inv.client.name}
                    </td>
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

function InvoiceStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    DRAFT: "bg-[#F5F5F4] text-[#78716C] border-[#E7E5E4]",
    APPROVED: "bg-[#EFF6FF] text-[#1E40AF] border-[#BFDBFE]",
    SENT: "bg-[#FEF3C7] text-[#92400E] border-[#FDE68A]",
    PAID: "bg-[#F0FDF4] text-[#166534] border-[#BBF7D0]",
    OVERDUE: "bg-[#FEF2F2] text-[#991B1B] border-[#FECACA]",
    VOID: "bg-[#F5F5F4] text-[#78716C] border-[#E7E5E4]",
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
