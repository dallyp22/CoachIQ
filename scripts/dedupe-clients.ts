/**
 * Merge a duplicate client row into a canonical one.
 *
 *   npx tsx scripts/dedupe-clients.ts                  # list duplicates
 *   npx tsx scripts/dedupe-clients.ts <keep> <orphan>  # dry-run merge
 *   npx tsx scripts/dedupe-clients.ts <keep> <orphan> --apply
 *
 * <keep> and <orphan> may be either client UUIDs or full email addresses.
 *
 * The merge:
 *   1. Re-points every Session, Transcript, TimeEntry, Invoice, PrepBrief,
 *      and BillingAuditLog FK from the orphan to the canonical row.
 *   2. Pushes the orphan's email + secondaryEmails into the canonical row's
 *      secondaryEmails array (deduped, normalized lowercase).
 *   3. Recomputes sessionCount on the canonical row.
 *   4. Deletes the orphan Client row.
 *
 * Runs inside a single transaction so partial state is impossible.
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

function makePrisma() {
  const adapter = new PrismaPg({
    connectionString:
      process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  return new PrismaClient({ adapter });
}

async function listDuplicates(prisma: PrismaClient) {
  const clients = await prisma.client.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      sessionCount: true,
      createdAt: true,
    },
    orderBy: { name: "asc" },
  });

  const groups = new Map<string, typeof clients>();
  for (const c of clients) {
    const key = c.name.trim().toLowerCase();
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  const dupes = [...groups.values()].filter((g) => g.length > 1);
  if (dupes.length === 0) {
    console.log("No duplicate-name clients found.");
    return;
  }

  console.log(`Found ${dupes.length} duplicate-name groups:\n`);
  for (const group of dupes) {
    console.log(`  ${group[0].name}`);
    for (const c of group) {
      console.log(
        `    ${c.id}  ${c.email.padEnd(40)}  sessions=${c.sessionCount}`
      );
    }
    console.log();
  }
  console.log(
    "To merge:  npx tsx scripts/dedupe-clients.ts <keep_email_or_id> <orphan_email_or_id> [--apply]"
  );
}

async function resolveClient(prisma: PrismaClient, identifier: string) {
  const looksLikeUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      identifier
    );
  if (looksLikeUuid) {
    return prisma.client.findUnique({ where: { id: identifier } });
  }
  // findFirst, not findUnique: client email is unique per coach now, so an
  // email alone can match more than one row. This maintenance script is run
  // interactively against a known duplicate — pass the id to disambiguate.
  return prisma.client.findFirst({
    where: { email: identifier.toLowerCase() },
  });
}

async function merge(
  prisma: PrismaClient,
  keepArg: string,
  orphanArg: string,
  apply: boolean
) {
  const keep = await resolveClient(prisma, keepArg);
  const orphan = await resolveClient(prisma, orphanArg);

  if (!keep) throw new Error(`Cannot find canonical client: ${keepArg}`);
  if (!orphan) throw new Error(`Cannot find orphan client: ${orphanArg}`);
  if (keep.id === orphan.id)
    throw new Error("keep and orphan are the same row");

  console.log("Plan:");
  console.log(
    `  KEEP   ${keep.id}  ${keep.name.padEnd(28)}  ${keep.email.padEnd(40)}  sessions=${keep.sessionCount}`
  );
  console.log(
    `  MERGE  ${orphan.id}  ${orphan.name.padEnd(28)}  ${orphan.email.padEnd(40)}  sessions=${orphan.sessionCount}`
  );

  // Survey what's attached to the orphan so we can show counts.
  const [
    sessionN,
    transcriptN,
    timeEntryN,
    invoiceN,
    prepBriefN,
    auditLogN,
  ] = await Promise.all([
    prisma.session.count({ where: { clientId: orphan.id } }),
    prisma.transcript.count({ where: { clientId: orphan.id } }),
    prisma.timeEntry.count({ where: { clientId: orphan.id } }),
    prisma.invoice.count({ where: { clientId: orphan.id } }),
    prisma.prepBrief.count({ where: { clientId: orphan.id } }),
    prisma.billingAuditLog.count({ where: { clientId: orphan.id } }),
  ]);

  console.log(
    `  to move:  sessions=${sessionN}  transcripts=${transcriptN}  timeEntries=${timeEntryN}  invoices=${invoiceN}  prepBriefs=${prepBriefN}  auditLogs=${auditLogN}`
  );

  // Build new secondaryEmails for the canonical row.
  const merged = new Set<string>();
  for (const e of keep.secondaryEmails) merged.add(e.toLowerCase());
  for (const e of orphan.secondaryEmails) merged.add(e.toLowerCase());
  if (orphan.email) merged.add(orphan.email.toLowerCase());
  merged.delete(keep.email.toLowerCase());
  const newSecondary = [...merged].sort();
  console.log(`  secondaryEmails -> [${newSecondary.join(", ")}]`);

  if (!apply) {
    console.log("\n(dry run — pass --apply to execute)");
    return;
  }

  await prisma.$transaction(async (tx) => {
    // Re-point every FK to the canonical client.
    await tx.session.updateMany({
      where: { clientId: orphan.id },
      data: { clientId: keep.id },
    });
    await tx.transcript.updateMany({
      where: { clientId: orphan.id },
      data: { clientId: keep.id },
    });
    await tx.timeEntry.updateMany({
      where: { clientId: orphan.id },
      data: { clientId: keep.id },
    });
    await tx.invoice.updateMany({
      where: { clientId: orphan.id },
      data: { clientId: keep.id },
    });
    await tx.prepBrief.updateMany({
      where: { clientId: orphan.id },
      data: { clientId: keep.id },
    });
    await tx.billingAuditLog.updateMany({
      where: { clientId: orphan.id },
      data: { clientId: keep.id },
    });

    // Update canonical row: stash the orphan's emails + recount sessions.
    const newCount = await tx.session.count({
      where: { clientId: keep.id },
    });
    await tx.client.update({
      where: { id: keep.id },
      data: {
        secondaryEmails: newSecondary,
        sessionCount: newCount,
      },
    });

    await tx.client.delete({ where: { id: orphan.id } });
  });

  console.log("\nMerged.");
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positional = args.filter((a) => !a.startsWith("--"));

  const prisma = makePrisma();
  try {
    if (positional.length === 0) {
      await listDuplicates(prisma);
    } else if (positional.length === 2) {
      const [keep, orphan] = positional;
      await merge(prisma, keep, orphan, apply);
    } else {
      console.error(
        "Usage:\n  npx tsx scripts/dedupe-clients.ts\n  npx tsx scripts/dedupe-clients.ts <keep> <orphan> [--apply]"
      );
      process.exit(2);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
