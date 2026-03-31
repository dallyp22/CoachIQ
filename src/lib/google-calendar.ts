import { google, calendar_v3 } from "googleapis";
import { prisma } from "@/lib/db";
import fs from "fs";

let _calendar: calendar_v3.Calendar | null = null;

/**
 * Load service account credentials from env var (JSON blob) or file path.
 * - GOOGLE_SERVICE_ACCOUNT_JSON: full JSON string (for Vercel)
 * - GOOGLE_SERVICE_ACCOUNT_PATH: path to JSON file (for local dev)
 */
function loadCredentials(): Record<string, unknown> {
  const jsonStr = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (jsonStr) return JSON.parse(jsonStr);

  const filePath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH;
  if (filePath) {
    const resolved = filePath.startsWith("/") ? filePath : `${process.cwd()}/${filePath}`;
    return JSON.parse(fs.readFileSync(resolved, "utf-8"));
  }

  throw new Error(
    "Google service account not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON (JSON blob) or GOOGLE_SERVICE_ACCOUNT_PATH (file path)."
  );
}

/**
 * Check if Google service account credentials are available.
 */
export function hasCalendarCredentials(): boolean {
  return !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_PATH);
}

/**
 * Singleton Google Calendar client using service account auth.
 */
export function getCalendar(): calendar_v3.Calendar {
  if (!_calendar) {
    const credentials = loadCredentials();
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });
    _calendar = google.calendar({ version: "v3", auth });
  }
  return _calendar;
}

/**
 * Fetch events for a given day (in America/Chicago timezone).
 */
export async function getTodayEvents(
  calendarId: string
): Promise<calendar_v3.Schema$Event[]> {
  const now = new Date();
  const startOfDay = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Chicago" }).split(",")[0]
  );
  // Use timezone-aware start/end
  const timeMin = new Date(
    startOfDay.toISOString().split("T")[0] + "T00:00:00-06:00"
  );
  const timeMax = new Date(
    startOfDay.toISOString().split("T")[0] + "T23:59:59-06:00"
  );

  return fetchEvents(calendarId, timeMin, timeMax);
}

/**
 * Fetch events within the next N hours.
 */
export async function getUpcomingEvents(
  calendarId: string,
  hours: number
): Promise<calendar_v3.Schema$Event[]> {
  const now = new Date();
  const timeMax = new Date(now.getTime() + hours * 60 * 60 * 1000);
  return fetchEvents(calendarId, now, timeMax);
}

/**
 * Find a calendar event matching a specific attendee email within a date range.
 */
export async function findEventByAttendee(
  calendarId: string,
  email: string,
  dateRange: { start: Date; end: Date }
): Promise<calendar_v3.Schema$Event | null> {
  const events = await fetchEvents(calendarId, dateRange.start, dateRange.end);
  const emailLower = email.toLowerCase();

  return (
    events.find((event) =>
      event.attendees?.some(
        (a) => a.email?.toLowerCase() === emailLower
      )
    ) ?? null
  );
}

/**
 * Core event fetcher. Returns all single events (expanded recurring) in the time range.
 */
async function fetchEvents(
  calendarId: string,
  timeMin: Date,
  timeMax: Date
): Promise<calendar_v3.Schema$Event[]> {
  const calendar = getCalendar();
  const allEvents: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;

  do {
    const res = await calendar.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      pageToken,
    });

    if (res.data.items) {
      allEvents.push(...res.data.items);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return allEvents;
}

/**
 * Filter events by coaching title regex from CoachSettings.
 */
export function filterCoachingEvents(
  events: calendar_v3.Schema$Event[],
  filterPattern?: string | null
): calendar_v3.Schema$Event[] {
  const pattern = filterPattern || "coaching|executive coaching|session";
  const regex = new RegExp(pattern, "i");
  return events.filter((e) => e.summary && regex.test(e.summary));
}

/**
 * Calculate duration in minutes from a calendar event.
 */
export function eventDurationMinutes(
  event: calendar_v3.Schema$Event
): number {
  const start = event.start?.dateTime
    ? new Date(event.start.dateTime)
    : null;
  const end = event.end?.dateTime ? new Date(event.end.dateTime) : null;
  if (!start || !end) return 0;
  return Math.round((end.getTime() - start.getTime()) / 60000);
}

/**
 * Get external attendee emails (excluding the coach's email).
 */
export async function getExternalAttendees(
  event: calendar_v3.Schema$Event
): Promise<string[]> {
  const settings = await prisma.coachSettings.findFirst();
  const coachEmail = settings?.coachEmail?.toLowerCase() || "";

  return (
    event.attendees
      ?.filter(
        (a) =>
          a.email &&
          a.email.toLowerCase() !== coachEmail &&
          !a.resource
      )
      .map((a) => a.email!.toLowerCase()) ?? []
  );
}
