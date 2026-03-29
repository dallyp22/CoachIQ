/**
 * Fetch all NotebookLM notebook IDs using browser cookies
 * and update the database.
 *
 * Run: npx tsx scripts/fetch-notebook-ids.ts
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// NotebookLM cookies from Todd's browser session
const COOKIES = [
  "__Secure-1PSID=g.a0008QhvD2q_5oZhMR_trsVsqAgxTzD-C1Pe_R7xymS545rt9of_-qDmxTtgmsk-EYsuLrvysAACgYKASASARESFQHGX2MiN6VbtEMNlxNduEEW4elWxBoVAUF8yKoaZltjqRLZI8ktDCGJlpWE0076",
  "__Secure-1PSIDTS=sidts-CjEBWhotCZcKulHXTUkAbKjQoFWYfsjbwUOl8bPP3MkBQ2QSPPMFZSvQshjcl6HES3GzEAA",
  "__Secure-3PSID=g.a0008QhvD2q_5oZhMR_trsVsqAgxTzD-C1Pe_R7xymS545rt9of_TPq-HDnXE5ADz9PUZzy_rwACgYKAU4SARESFQHGX2Midcoh9UlA4JVdIP--RgDY_BoVAUF8yKp6k6Phad93wfOMoS0j4mAH0076",
  "__Secure-3PSIDTS=sidts-CjEBWhotCZcKulHXTUkAbKjQoFWYfsjbwUOl8bPP3MkBQ2QSPPMFZSvQshjcl6HES3GzEAA",
  "SID=g.a0008QhvD2q_5oZhMR_trsVsqAgxTzD-C1Pe_R7xymS545rt9of_NUSUW6hqKk5FHFmWYSvjtAACgYKAeASARESFQHGX2MiqI1TCsrkNYbfj6zJ__xI2RoVAUF8yKpayilqCbABf8GrGlQi4HAI0076",
  "HSID=AdxsRjiUXeyZISR36",
  "SSID=AD8FI1TXV7xKEj9aB",
  "APISID=FYaHja_DAsH9SfEi/ArxxGIDTmmXjQYPdD",
  "SAPISID=NQ5VItb-YnosO31v/AgqlhpFJsS1xBhLIM",
  "__Secure-1PAPISID=NQ5VItb-YnosO31v/AgqlhpFJsS1xBhLIM",
  "__Secure-3PAPISID=NQ5VItb-YnosO31v/AgqlhpFJsS1xBhLIM",
  "OSID=g.a0008QhvD_cS2FnKNRnBNIssQov1bh2zu3L92i4QGIrnq3HOVgx20sFfA37IPj1wB6aF64u8CgACgYKAfoSARESFQHGX2Mis4ZUD4fLT1SlLVNg1Qk7QBoVAUF8yKq8qTFTz7tyhUvXDKc4Zw7G0076",
  "__Secure-OSID=g.a0008QhvD_cS2FnKNRnBNIssQov1bh2zu3L92i4QGIrnq3HOVgx2XxOjLa_IkG52BGLu9UjTEgACgYKAZwSARESFQHGX2MimpFuwqCQDUr3f8j8YvfGUBoVAUF8yKph07dLg44kzPpWxrE4BAhc0076",
  "NID=530=dWM15oIs4oe03LTrKzZT2neofeLhte_KfZkCz0-4uSMABVw3bc4eVNgaUKl4_jjW2hr4a7RPvlsP8XJ44E4B-rN1tn5bUfj6BEQmPBtcOCRIyg_LPAHbBcDKe1mszu_STCJtYwWtvhVstjRLTuZwhwuE84B3-L-ouLS3b4KI03JIRTyOc8UCk2PhBlHgQHAZ9GeLPeqb3QvTTzbGhcAfKQzDdVbas_8Qwh3VYkuj6Bh4XnIXLTfUavY0hBJupXSr_jd8zQQgAz7BursJ6ueLlwUYWBnIeUBhriyadpFPhslhkWcQ6Hb_W8rvDYHzGHYVIqo",
].join("; ");

async function main() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });

  // Try to fetch notebooks from NotebookLM's internal API
  console.log("Fetching notebooks from NotebookLM...");

  const resp = await fetch(
    "https://notebooklm.google.com/api/notebooks",
    {
      headers: {
        Cookie: COOKIES,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "application/json",
        Referer: "https://notebooklm.google.com/",
      },
    }
  );

  if (!resp.ok) {
    // Try the older RPC endpoint
    console.log(`API endpoint returned ${resp.status}, trying RPC...`);

    const rpcResp = await fetch(
      "https://notebooklm.google.com/r/v1alpha1/projects/-/notebooks?pageSize=200",
      {
        headers: {
          Cookie: COOKIES,
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Accept: "application/json",
          Referer: "https://notebooklm.google.com/",
          "Content-Type": "application/json",
        },
      }
    );

    if (!rpcResp.ok) {
      const text = await rpcResp.text();
      console.log(`RPC also failed (${rpcResp.status}): ${text.slice(0, 300)}`);
      console.log("\nFalling back to notebooklm CLI...");

      // Try using notebooklm CLI with the cookies
      const { execSync } = await import("child_process");
      try {
        const output = execSync(
          `notebooklm --storage ~/.notebooklm/todd_storage_state.json list --json`,
          { encoding: "utf-8", timeout: 30000 }
        );
        const data = JSON.parse(output);
        const notebooks = Array.isArray(data) ? data : data.notebooks || [];
        const coachiq = notebooks.filter((n: { title: string }) =>
          n.title?.startsWith("CoachIQ |")
        );
        console.log(`Found ${coachiq.length} CoachIQ notebooks`);

        for (const nb of coachiq) {
          const clientName = nb.title.replace("CoachIQ | ", "").trim();
          await updateNotebookId(prisma, clientName, nb.id);
        }
      } catch (e) {
        console.log("CLI also failed. Cookies may need to be refreshed in the notebooklm CLI.");
        console.log("Run: notebooklm login");
      }

      await printSummary(prisma);
      await prisma.$disconnect();
      return;
    }

    const data = await rpcResp.json();
    const notebooks = data.notebooks || [];
    console.log(`Found ${notebooks.length} notebooks`);

    const coachiq = notebooks.filter((n: { title?: string }) =>
      n.title?.startsWith("CoachIQ |")
    );
    console.log(`CoachIQ notebooks: ${coachiq.length}`);

    for (const nb of coachiq) {
      const clientName = nb.title.replace("CoachIQ | ", "").trim();
      const nbId = nb.name?.split("/").pop() || nb.id;
      await updateNotebookId(prisma, clientName, nbId);
    }
  } else {
    const data = await resp.json();
    console.log(`Got ${JSON.stringify(data).slice(0, 200)}...`);
  }

  await printSummary(prisma);
  await prisma.$disconnect();
}

async function updateNotebookId(
  prisma: PrismaClient,
  clientName: string,
  notebookId: string
) {
  // Try exact match first, then fuzzy
  const result = await prisma.client.updateMany({
    where: {
      name: { contains: clientName, mode: "insensitive" as const },
      notebookId: null,
    },
    data: { notebookId },
  });

  if (result.count > 0) {
    console.log(`  Linked: ${clientName} → ${notebookId}`);
  }
}

async function printSummary(prisma: PrismaClient) {
  const withNotebook = await prisma.client.count({
    where: { notebookId: { not: null } },
  });
  const total = await prisma.client.count();
  console.log(`\nNotebook IDs linked: ${withNotebook}/${total} clients`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
