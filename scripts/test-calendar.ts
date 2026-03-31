import "dotenv/config";
import { google } from "googleapis";
import fs from "fs";

async function main() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    || fs.readFileSync("./service-account.json", "utf-8");

  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });

  const calendar = google.calendar({ version: "v3", auth });
  const calendarId = "todd@growwithcocreate.com";

  console.log("Testing calendar access...\n");

  // Test 1: Get calendar metadata
  try {
    const calRes = await calendar.calendars.get({ calendarId });
    console.log("Calendar found:");
    console.log(`  Name: ${calRes.data.summary}`);
    console.log(`  Timezone: ${calRes.data.timeZone}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Calendar access failed:", msg);
    console.log("\nMake sure Todd shared his calendar with:");
    console.log("  coachiq-pipeline@coachiq-491616.iam.gserviceaccount.com");
    process.exit(1);
  }

  // Test 2: List upcoming events
  const now = new Date();
  const oneWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const events = await calendar.events.list({
    calendarId,
    timeMin: now.toISOString(),
    timeMax: oneWeek.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 10,
  });

  const items = events.data.items || [];
  console.log(`\nUpcoming events (next 7 days): ${items.length}`);

  for (const event of items) {
    const start = event.start?.dateTime || event.start?.date || "?";
    const attendees = event.attendees?.map(a => a.email).join(", ") || "none";
    console.log(`  ${start} — ${event.summary}`);
    console.log(`    Attendees: ${attendees}`);
  }

  // Test 3: Check for coaching-related events
  const coachingFilter = /coaching|executive coaching|session/i;
  const coachingEvents = items.filter(e => e.summary && coachingFilter.test(e.summary));
  console.log(`\nCoaching events matching filter: ${coachingEvents.length}`);
  for (const e of coachingEvents) {
    console.log(`  ${e.start?.dateTime || e.start?.date} — ${e.summary}`);
  }
}

main().catch(console.error);
