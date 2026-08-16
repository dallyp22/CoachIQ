import { Sidebar } from "@/components/sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { requireCoachPage } from "@/lib/authz-page";
import { feedbackUnreadCount } from "@/lib/feedback-notify";
import { FloatingReport } from "@/components/floating-report";

/**
 * One gate for the whole dashboard.
 *
 * Pages that read coach-owned data still resolve their own coach — they need
 * the id to scope their queries. This layer exists so that pages holding no
 * server data (client components fetching from already-scoped APIs) still
 * send a signed-in stranger to /no-access, rather than rendering a shell that
 * fails request by request.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const coach = await requireCoachPage();
  // OWNER/ADMIN get the practice-wide nav (Practice page). A COACH never sees it.
  const isAdmin = coach.role !== "COACH";
  const feedbackUnread = await feedbackUnreadCount(coach);

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <MobileNav isAdmin={isAdmin} feedbackUnread={feedbackUnread} />
      <Sidebar isAdmin={isAdmin} feedbackUnread={feedbackUnread} />
      <main className="flex-1 overflow-y-auto bg-background pb-20 lg:pb-0">
        <div className="max-w-[1200px] mx-auto px-4 py-6 lg:px-10 lg:py-8">
          {children}
        </div>
      </main>
      <FloatingReport />
    </div>
  );
}
