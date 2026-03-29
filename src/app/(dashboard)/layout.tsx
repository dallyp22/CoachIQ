import { Sidebar } from "@/components/sidebar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-background">
        <div className="max-w-[1200px] mx-auto px-6 py-8 lg:px-10">
          {children}
        </div>
      </main>
    </div>
  );
}
