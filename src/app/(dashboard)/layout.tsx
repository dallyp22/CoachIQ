import { Sidebar } from "@/components/sidebar";
import { MobileNav } from "@/components/mobile-nav";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col lg:flex-row">
      <MobileNav />
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-background pb-20 lg:pb-0">
        <div className="max-w-[1200px] mx-auto px-4 py-6 lg:px-10 lg:py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
