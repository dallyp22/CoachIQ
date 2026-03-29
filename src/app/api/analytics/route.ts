import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * GET /api/analytics — aggregate analytics data
 */
export async function GET() {
  // Sessions per month (last 12 months)
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  const sessions = await prisma.session.findMany({
    where: { date: { gte: twelveMonthsAgo } },
    select: { date: true, durationMinutes: true, billableMinutes: true, clientId: true },
    orderBy: { date: "asc" },
  });

  // Group by month
  const sessionsByMonth: Record<string, { sessions: number; hours: number; revenue: number }> = {};
  for (const s of sessions) {
    const month = s.date.toISOString().slice(0, 7); // YYYY-MM
    if (!sessionsByMonth[month]) {
      sessionsByMonth[month] = { sessions: 0, hours: 0, revenue: 0 };
    }
    sessionsByMonth[month].sessions++;
    const billableHrs = Math.ceil(s.durationMinutes / 15) * 0.25;
    sessionsByMonth[month].hours += billableHrs;
    sessionsByMonth[month].revenue += billableHrs * 300; // Default rate
  }

  const monthlyData = Object.entries(sessionsByMonth).map(([month, data]) => ({
    month,
    label: new Date(month + "-01").toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
    ...data,
    revenue: Math.round(data.revenue),
  }));

  // Top clients by session count
  const topClients = await prisma.client.findMany({
    where: { sessionCount: { gt: 0 } },
    orderBy: { sessionCount: "desc" },
    take: 15,
    select: { name: true, sessionCount: true, hourlyRate: true },
  });

  const topClientsData = topClients.map((c) => ({
    name: c.name.split(" ")[0], // First name for chart labels
    fullName: c.name,
    sessions: c.sessionCount,
    revenue: Math.round(c.sessionCount * Number(c.hourlyRate)), // Rough estimate
  }));

  // Overall stats
  const totalClients = await prisma.client.count({ where: { status: "ACTIVE" } });
  const totalSessions = await prisma.session.count();
  const totalTranscripts = await prisma.transcript.count();

  const allTimeEntries = await prisma.timeEntry.findMany({
    select: { amount: true, status: true },
  });
  const totalBilled = allTimeEntries.reduce((sum, e) => sum + Number(e.amount), 0);
  const totalPaid = allTimeEntries
    .filter((e) => e.status === "PAID")
    .reduce((sum, e) => sum + Number(e.amount), 0);
  const totalUnbilled = allTimeEntries
    .filter((e) => e.status === "UNBILLED")
    .reduce((sum, e) => sum + Number(e.amount), 0);

  // Sessions per client distribution
  const clientSessionCounts = await prisma.client.findMany({
    where: { sessionCount: { gt: 0 } },
    select: { sessionCount: true },
  });
  const avgSessionsPerClient =
    clientSessionCounts.length > 0
      ? clientSessionCounts.reduce((sum, c) => sum + c.sessionCount, 0) / clientSessionCounts.length
      : 0;

  return NextResponse.json({
    monthlyData,
    topClientsData,
    stats: {
      totalClients,
      totalSessions,
      totalTranscripts,
      totalBilled: Math.round(totalBilled),
      totalPaid: Math.round(totalPaid),
      totalUnbilled: Math.round(totalUnbilled),
      avgSessionsPerClient: Math.round(avgSessionsPerClient * 10) / 10,
      clientsWithSessions: clientSessionCounts.length,
    },
  });
}
