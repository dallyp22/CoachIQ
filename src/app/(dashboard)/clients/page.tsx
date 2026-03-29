import { prisma } from "@/lib/db";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const clients = await prisma.client.findMany({
    orderBy: { name: "asc" },
    include: {
      sessions: {
        take: 1,
        orderBy: { date: "desc" },
        select: { date: true },
      },
    },
  });

  const activeCount = clients.filter((c) => c.status === "ACTIVE").length;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h1 className="font-display text-[32px] text-foreground">Clients</h1>
          <p className="text-sm text-muted mt-1">
            {activeCount} active of {clients.length} total
          </p>
        </div>
      </div>

      {clients.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="bg-surface border border-border rounded-[var(--radius-lg)] overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium">
                  Name
                </th>
                <th className="text-left px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium hidden md:table-cell">
                  Company
                </th>
                <th className="text-left px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium hidden sm:table-cell">
                  Status
                </th>
                <th className="text-left px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium">
                  Sessions
                </th>
                <th className="text-right px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium hidden lg:table-cell">
                  Last Session
                </th>
                <th className="text-right px-5 py-3 text-xs text-muted uppercase tracking-wide font-medium hidden sm:table-cell">
                  <span className="sr-only">Links</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr
                  key={client.id}
                  className="border-b border-border last:border-b-0 hover:bg-background transition-colors"
                >
                  <td className="px-5 py-4">
                    <Link
                      href={`/clients/${client.id}`}
                      className="font-display text-base text-foreground hover:text-accent transition-colors"
                    >
                      {client.name}
                    </Link>
                    <p className="text-xs text-muted mt-0.5 md:hidden">
                      {client.company || "—"}
                    </p>
                  </td>
                  <td className="px-5 py-4 text-sm text-muted hidden md:table-cell">
                    {client.company || "—"}
                  </td>
                  <td className="px-5 py-4 hidden sm:table-cell">
                    <StatusBadge status={client.status} />
                  </td>
                  <td className="px-5 py-4 font-mono text-sm text-foreground">
                    {client.sessionCount}
                  </td>
                  <td className="px-5 py-4 text-right font-mono text-sm text-muted hidden lg:table-cell">
                    {client.sessions[0]
                      ? new Date(client.sessions[0].date).toLocaleDateString(
                          "en-US",
                          { month: "short", day: "numeric" }
                        )
                      : "—"}
                  </td>
                  <td className="px-5 py-4 text-right hidden sm:table-cell">
                    {client.notebookId ? (
                      <a
                        href={`https://notebooklm.google.com/notebook/${client.notebookId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center text-accent hover:text-accent-hover transition-colors"
                        title="Open NotebookLM"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
                        </svg>
                      </a>
                    ) : (
                      <span className="inline-flex items-center text-border" title="Notebook not linked">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
                        </svg>
                      </span>
                    )}
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

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    ACTIVE: "bg-[#F0FDF4] text-[#166534] border-[#BBF7D0]",
    PAUSED: "bg-[#FEFCE8] text-[#854D0E] border-[#FEF08A]",
    CHURNED: "bg-[#FEF2F2] text-[#991B1B] border-[#FECACA]",
    PROSPECT: "bg-[#EFF6FF] text-[#1E40AF] border-[#BFDBFE]",
  };

  return (
    <span
      className={`inline-block px-2 py-0.5 text-xs font-medium rounded border ${
        styles[status] || styles.ACTIVE
      }`}
    >
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-16">
      <h2 className="font-display text-xl text-foreground">No clients yet</h2>
      <p className="text-sm text-muted mt-2 max-w-sm mx-auto">
        Import from Fathom to get started. Clients are automatically detected
        from your coaching session recordings.
      </p>
      <button className="mt-6 px-5 py-2.5 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors">
        Import from Fathom
      </button>
    </div>
  );
}
