import { NextResponse } from "next/server";
import { getCalendar, hasCalendarCredentials } from "@/lib/google-calendar";
import { prisma } from "@/lib/db";

/**
 * GET /api/calendar/test — verify the service account can access Todd's calendar.
 */
export async function GET() {
  try {
    if (!hasCalendarCredentials()) {
      return NextResponse.json(
        {
          status: "error",
          error: "Google service account not configured.",
          setup: "Set GOOGLE_SERVICE_ACCOUNT_JSON (JSON blob) or GOOGLE_SERVICE_ACCOUNT_PATH (file path).",
        },
        { status: 500 }
      );
    }

    const settings = await prisma.coachSettings.findFirst();
    const calendarId = settings?.googleCalendarId;

    if (!calendarId) {
      return NextResponse.json(
        {
          status: "error",
          error: "No Google Calendar ID configured.",
          setup: "Go to Settings and enter your Google Calendar ID (usually 'primary' or your email).",
        },
        { status: 400 }
      );
    }

    const calendar = getCalendar();

    // Try to fetch the calendar metadata
    const calendarRes = await calendar.calendars.get({ calendarId });

    // Try fetching a few events to confirm read access
    const now = new Date();
    const oneWeekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const eventsRes = await calendar.events.list({
      calendarId,
      timeMin: now.toISOString(),
      timeMax: oneWeekAhead.toISOString(),
      maxResults: 5,
      singleEvents: true,
      orderBy: "startTime",
    });

    return NextResponse.json({
      status: "connected",
      calendar: {
        id: calendarRes.data.id,
        summary: calendarRes.data.summary,
        timeZone: calendarRes.data.timeZone,
      },
      upcomingEvents: eventsRes.data.items?.length ?? 0,
      serviceAccount: "coachiq-pipeline@coachiq-491616.iam.gserviceaccount.com",
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error";

    // Provide helpful setup instructions for common errors
    let setup = "";
    if (message.includes("Not Found") || message.includes("notFound")) {
      setup = `Calendar not found. Make sure Todd has shared his Google Calendar with coachiq-pipeline@coachiq-491616.iam.gserviceaccount.com (read-only access).`;
    } else if (message.includes("forbidden") || message.includes("403")) {
      setup = `Access denied. Todd needs to share his calendar with coachiq-pipeline@coachiq-491616.iam.gserviceaccount.com and grant at least "See all event details" permission.`;
    } else if (message.includes("invalid_grant") || message.includes("auth")) {
      setup = `Authentication failed. Check that your service account credentials are valid.`;
    }

    return NextResponse.json(
      { status: "error", error: message, setup },
      { status: 500 }
    );
  }
}
