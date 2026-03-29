import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL_UNPOOLED! });
  const prisma = new PrismaClient({ adapter });

  const sessions = await prisma.session.count();
  const clients = await prisma.client.count();
  const withSessions = await prisma.client.count({ where: { sessionCount: { gt: 0 } } });
  const transcripts = await prisma.transcript.count();

  console.log(`Clients: ${clients}`);
  console.log(`Clients with sessions: ${withSessions}`);
  console.log(`Sessions: ${sessions}`);
  console.log(`Transcripts: ${transcripts}`);

  await prisma.$disconnect();
}

main();
