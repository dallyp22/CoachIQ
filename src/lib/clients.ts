import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * Client creation, extracted from /api/clients so the MCP `create_client` tool
 * and the HTTP route share one implementation (validation, rate fallback, and
 * per-coach duplicate handling). The CALLER decides which coach's book the
 * clients land in and passes that coachId — a COACH may only ever pass their
 * own id (the route enforces that); this function trusts the resolved coachId.
 */

export type ClientInput = {
  name?: unknown;
  email?: unknown;
  secondaryEmails?: unknown;
  company?: unknown;
  phone?: unknown;
  hourlyRate?: unknown;
  billingCadence?: unknown;
  meetingCadence?: unknown;
  notes?: unknown;
};

export const BILLING_CADENCES = ["WEEKLY", "BIWEEKLY", "MONTHLY", "CUSTOM_DAYS"];
export const MEETING_CADENCES = ["WEEKLY", "BIWEEKLY", "MONTHLY", "AD_HOC"];

export interface CreateClientsResult {
  created: Array<{ id: string; name: string; email: string }>;
  failed: Array<{ email: string; error: string }>;
}

export async function createClients(
  coachId: string,
  rows: ClientInput[]
): Promise<CreateClientsResult> {
  // The owning coach's rate is the default for their clients; the practice
  // default is the fallback. Rates still freeze onto each TimeEntry at session
  // time — this only sets the client's standing rate.
  const [owningCoach, practice] = await Promise.all([
    prisma.coach.findUnique({ where: { id: coachId }, select: { defaultHourlyRate: true } }),
    prisma.coachSettings.findFirst({ select: { defaultHourlyRate: true } }),
  ]);
  const fallbackRate = owningCoach?.defaultHourlyRate ?? practice?.defaultHourlyRate ?? null;

  const created: CreateClientsResult["created"] = [];
  const failed: CreateClientsResult["failed"] = [];

  for (const row of rows) {
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const email = typeof row.email === "string" ? row.email.trim().toLowerCase() : "";

    if (!name || !email.includes("@")) {
      failed.push({ email: email || "(missing)", error: "A name and a valid email are required" });
      continue;
    }

    const rate =
      row.hourlyRate !== undefined && row.hourlyRate !== null && row.hourlyRate !== ""
        ? String(row.hourlyRate)
        : fallbackRate;

    try {
      const client = await prisma.client.create({
        data: {
          coachId,
          name,
          email,
          secondaryEmails: Array.isArray(row.secondaryEmails)
            ? [
                ...new Set(
                  row.secondaryEmails
                    .filter((e: unknown): e is string => typeof e === "string" && e.includes("@"))
                    .map((e: string) => e.trim().toLowerCase())
                ),
              ]
            : [],
          company: typeof row.company === "string" && row.company.trim() ? row.company.trim() : null,
          phone: typeof row.phone === "string" && row.phone.trim() ? row.phone.trim() : null,
          ...(rate !== null && rate !== undefined ? { hourlyRate: rate as never } : {}),
          ...(typeof row.billingCadence === "string" && BILLING_CADENCES.includes(row.billingCadence)
            ? { billingCadence: row.billingCadence as never }
            : {}),
          ...(typeof row.meetingCadence === "string" && MEETING_CADENCES.includes(row.meetingCadence)
            ? { meetingCadence: row.meetingCadence as never }
            : {}),
          notes: typeof row.notes === "string" && row.notes.trim() ? row.notes.trim() : null,
          status: "ACTIVE",
        },
        select: { id: true, name: true, email: true },
      });
      created.push(client);
    } catch (err) {
      // Email is unique PER COACH, so this fires only on a duplicate within the
      // same coach's book — the same person coached by two different coaches is
      // legitimate and must not collide.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        failed.push({ email, error: "This coach already has a client with that email" });
      } else {
        failed.push({ email, error: err instanceof Error ? err.message : "Unknown error" });
      }
    }
  }

  return { created, failed };
}
