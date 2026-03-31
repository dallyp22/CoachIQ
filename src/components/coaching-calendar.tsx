"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

type ViewMode = "day" | "week" | "month";

interface CalendarEvent {
  eventId: string;
  title: string;
  start: string;
  end: string;
  durationMinutes: number;
  client: {
    id: string;
    name: string;
    company: string | null;
    sessionCount: number;
    meetingCadence: string;
  } | null;
  synopsisPreview: string | null;
  lastSynopsis: string | null;
  actionItems: Array<{ description?: string }>;
  briefId: string | null;
  briefContent: string | null;
}

interface DayData {
  date: string;
  events: CalendarEvent[];
}

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function getToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
}

function getWeekRange(dateStr: string): { start: string; end: string } {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay();
  const start = new Date(d);
  start.setDate(d.getDate() - day + 1); // Monday
  const end = new Date(start);
  end.setDate(start.getDate() + 4); // Friday
  return {
    start: start.toLocaleDateString("en-CA"),
    end: end.toLocaleDateString("en-CA"),
  };
}

function getMonthRange(dateStr: string): { start: string; end: string } {
  const d = new Date(dateStr + "T12:00:00");
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return {
    start: start.toLocaleDateString("en-CA"),
    end: end.toLocaleDateString("en-CA"),
  };
}

function getMonthLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function getWeekLabel(dateStr: string): string {
  const { start, end } = getWeekRange(dateStr);
  const s = new Date(start + "T12:00:00");
  const e = new Date(end + "T12:00:00");
  const sStr = s.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const eStr = e.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${sStr} – ${eStr}`;
}

export function CoachingCalendar() {
  const [viewMode, setViewMode] = useState<ViewMode>("day");
  const [currentDate, setCurrentDate] = useState(getToday());
  const [days, setDays] = useState<DayData[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const [generatingBrief, setGeneratingBrief] = useState<Set<string>>(new Set());
  const [morningBrief, setMorningBrief] = useState<string | null>(null);
  const [morningBriefLoading, setMorningBriefLoading] = useState(false);
  const [morningBriefExpanded, setMorningBriefExpanded] = useState(false);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      let timeMin: string;
      let timeMax: string;

      if (viewMode === "day") {
        timeMin = `${currentDate}T00:00:00`;
        timeMax = `${currentDate}T23:59:59`;
      } else if (viewMode === "week") {
        const range = getWeekRange(currentDate);
        timeMin = `${range.start}T00:00:00`;
        timeMax = `${range.end}T23:59:59`;
      } else {
        const range = getMonthRange(currentDate);
        timeMin = `${range.start}T00:00:00`;
        timeMax = `${range.end}T23:59:59`;
      }

      const res = await fetch(
        `/api/calendar/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
      );
      const data = await res.json();
      const events: CalendarEvent[] = data.events || [];

      // Group by date
      const byDate = new Map<string, CalendarEvent[]>();
      for (const event of events) {
        const dateKey = event.start
          ? new Date(event.start).toLocaleDateString("en-CA", { timeZone: "America/Chicago" })
          : currentDate;
        if (!byDate.has(dateKey)) byDate.set(dateKey, []);
        byDate.get(dateKey)!.push(event);
      }

      // Build sorted day list
      const sortedDays: DayData[] = [...byDate.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, events]) => ({ date, events }));

      // For day view, always show the selected day even if empty
      if (viewMode === "day" && sortedDays.length === 0) {
        sortedDays.push({ date: currentDate, events: [] });
      }

      setDays(sortedDays);
    } catch {
      setDays([]);
    } finally {
      setLoading(false);
    }
  }, [viewMode, currentDate]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  function navigate(direction: -1 | 1) {
    if (viewMode === "day") {
      setCurrentDate(addDays(currentDate, direction));
    } else if (viewMode === "week") {
      setCurrentDate(addDays(currentDate, direction * 7));
    } else {
      const d = new Date(currentDate + "T12:00:00");
      d.setMonth(d.getMonth() + direction);
      setCurrentDate(d.toLocaleDateString("en-CA"));
    }
  }

  function goToToday() {
    setCurrentDate(getToday());
  }

  function toggleExpand(eventId: string) {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  }

  async function generateBrief(clientId: string, eventId: string) {
    setGeneratingBrief((prev) => new Set(prev).add(eventId));
    try {
      const resp = await fetch(`/api/clients/${clientId}/prep-brief`, { method: "POST" });
      if (resp.ok) {
        await fetchEvents(); // Refresh to show new brief
        setExpandedEvents((prev) => new Set(prev).add(eventId));
      }
    } finally {
      setGeneratingBrief((prev) => {
        const next = new Set(prev);
        next.delete(eventId);
        return next;
      });
    }
  }

  async function handleMorningBrief() {
    if (morningBrief && !morningBriefLoading) {
      setMorningBriefExpanded(!morningBriefExpanded);
      return;
    }
    setMorningBriefLoading(true);
    try {
      const resp = await fetch("/api/daily-brief");
      const data = await resp.json();
      if (data.brief) {
        setMorningBrief(data.brief);
        setMorningBriefExpanded(true);
      }
    } finally {
      setMorningBriefLoading(false);
    }
  }

  const allEvents = days.flatMap((d) => d.events);
  const totalBillableHrs = allEvents.reduce(
    (sum, e) => sum + Math.ceil(e.durationMinutes / 15) * 0.25,
    0
  );

  const headerLabel =
    viewMode === "day"
      ? formatDateLabel(currentDate)
      : viewMode === "week"
        ? getWeekLabel(currentDate)
        : getMonthLabel(currentDate);

  const isToday = currentDate === getToday();

  return (
    <div className="mt-10 border-t border-border pt-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h2 className="font-display text-[22px] text-foreground">Coaching Schedule</h2>

        <div className="flex items-center gap-2">
          {viewMode === "day" && allEvents.length > 0 && (
            <button
              onClick={handleMorningBrief}
              disabled={morningBriefLoading}
              className="px-3 py-1.5 bg-accent text-white text-xs font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
            >
              {morningBriefLoading
                ? "Generating..."
                : morningBrief
                  ? morningBriefExpanded ? "Hide Day Brief" : "Show Day Brief"
                  : "Generate Day Brief"}
            </button>
          )}

          {/* View mode toggle */}
          <div className="flex border border-border rounded overflow-hidden">
            {(["day", "week", "month"] as ViewMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  viewMode === mode
                    ? "bg-foreground text-background"
                    : "bg-surface text-muted hover:text-foreground"
                }`}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Date navigation */}
      <div className="flex items-center gap-3 mt-3">
        <button
          onClick={() => navigate(-1)}
          className="p-1.5 border border-border rounded hover:border-accent hover:text-accent transition-colors"
          aria-label="Previous"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button
          onClick={() => navigate(1)}
          className="p-1.5 border border-border rounded hover:border-accent hover:text-accent transition-colors"
          aria-label="Next"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <span className="text-sm font-medium text-foreground">{headerLabel}</span>
        {!isToday && (
          <button
            onClick={goToToday}
            className="text-xs text-accent hover:underline font-medium"
          >
            Today
          </button>
        )}
        {!loading && allEvents.length > 0 && (
          <span className="text-xs text-muted ml-auto">
            {allEvents.length} session{allEvents.length !== 1 ? "s" : ""} &middot;{" "}
            {totalBillableHrs.toFixed(1)} billable hrs
          </span>
        )}
      </div>

      {/* Morning brief */}
      {morningBriefExpanded && morningBrief && (
        <div className="mt-4 bg-surface border border-border border-l-3 border-l-accent rounded-r-[var(--radius-md)] p-5">
          <div className="prose prose-sm max-w-none text-foreground text-sm leading-relaxed whitespace-pre-line [&_strong]:font-semibold [&_strong]:text-foreground">
            {morningBrief}
          </div>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="mt-4 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 bg-border/30 rounded animate-pulse" />
          ))}
        </div>
      ) : allEvents.length === 0 ? (
        <p className="text-sm text-muted mt-4">
          No coaching sessions scheduled{viewMode === "day" ? " for this day" : ` this ${viewMode}`}.
        </p>
      ) : (
        <div className="mt-4 space-y-1">
          {days.map((day) => (
            <div key={day.date}>
              {/* Day header for week/month views */}
              {viewMode !== "day" && (
                <div className="flex items-center gap-2 mt-4 mb-2 first:mt-0">
                  <span className={`font-mono text-xs font-medium ${
                    day.date === getToday() ? "text-accent" : "text-muted"
                  }`}>
                    {formatShortDate(day.date)}
                  </span>
                  <div className="flex-1 border-t border-border" />
                  <span className="text-[10px] text-muted">
                    {day.events.length} session{day.events.length !== 1 ? "s" : ""}
                  </span>
                </div>
              )}

              {/* Event cards */}
              <div className="space-y-2">
                {day.events.map((event) => {
                  const isExpanded = expandedEvents.has(event.eventId || "");
                  const isGenerating = generatingBrief.has(event.eventId || "");

                  const startTime = event.start
                    ? new Date(event.start).toLocaleTimeString("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                        timeZone: "America/Chicago",
                      })
                    : "";
                  const endTime = event.end
                    ? new Date(event.end).toLocaleTimeString("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                        timeZone: "America/Chicago",
                      })
                    : "";

                  return (
                    <div
                      key={event.eventId}
                      className={`bg-surface border rounded-[var(--radius-md)] transition-colors ${
                        isExpanded ? "border-accent/40" : "border-border hover:border-border/80"
                      }`}
                    >
                      {/* Collapsed card — always visible */}
                      <button
                        onClick={() => toggleExpand(event.eventId || "")}
                        className="w-full text-left p-4 cursor-pointer"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-sm text-accent font-medium">
                                {startTime}
                              </span>
                              <span className="text-xs text-muted">–</span>
                              <span className="font-mono text-xs text-muted">{endTime}</span>
                            </div>
                            <p className="text-sm font-medium text-foreground mt-1">
                              {event.client ? (
                                <>
                                  {event.client.name}
                                  {event.client.company && (
                                    <span className="text-muted font-normal">
                                      {" "}— {event.client.company}
                                    </span>
                                  )}
                                </>
                              ) : (
                                event.title
                              )}
                            </p>
                            {!isExpanded && event.synopsisPreview && (
                              <p className="text-xs text-muted mt-1 line-clamp-1 italic">
                                {event.synopsisPreview}
                              </p>
                            )}
                            {!isExpanded && event.briefContent && (
                              <span className="inline-block mt-1 text-[10px] font-mono uppercase tracking-wider text-success">
                                Brief ready
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="font-mono text-xs text-muted bg-background border border-border px-2 py-0.5 rounded">
                              {event.durationMinutes} min
                            </span>
                            <ChevronDown
                              className={`w-4 h-4 text-muted transition-transform ${
                                isExpanded ? "rotate-180" : ""
                              }`}
                            />
                          </div>
                        </div>
                      </button>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <div className="px-4 pb-4 border-t border-border/50 pt-3 space-y-3">
                          {/* Client meta */}
                          {event.client && (
                            <div className="flex items-center gap-4 text-xs text-muted">
                              <span className="font-mono">{event.client.sessionCount} sessions</span>
                              <span className="font-mono">
                                {event.client.meetingCadence.charAt(0) +
                                  event.client.meetingCadence.slice(1).toLowerCase()}{" "}
                                cadence
                              </span>
                              <Link
                                href={`/clients/${event.client.id}`}
                                className="text-accent hover:underline ml-auto"
                                onClick={(e) => e.stopPropagation()}
                              >
                                View Dossier
                              </Link>
                            </div>
                          )}

                          {/* Last session synopsis */}
                          {event.lastSynopsis && (
                            <div>
                              <p className="text-[10px] font-mono uppercase tracking-wider text-muted mb-1">
                                Last Session
                              </p>
                              <p className="text-sm text-foreground/80 leading-relaxed">
                                {event.lastSynopsis}
                              </p>
                            </div>
                          )}

                          {/* Action items */}
                          {event.actionItems.length > 0 && (
                            <div>
                              <p className="text-[10px] font-mono uppercase tracking-wider text-muted mb-1">
                                Open Action Items
                              </p>
                              <ul className="space-y-1">
                                {event.actionItems.map((item, i) => (
                                  <li key={i} className="text-sm text-foreground/80 flex gap-2">
                                    <span className="text-accent shrink-0">•</span>
                                    {item.description}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {/* Prep brief */}
                          {event.briefContent ? (
                            <div>
                              <p className="text-[10px] font-mono uppercase tracking-wider text-success mb-1">
                                Prep Brief
                              </p>
                              <div className="bg-background border border-border rounded p-3 text-sm text-foreground/80 leading-relaxed whitespace-pre-line [&_strong]:font-semibold [&_strong]:text-foreground">
                                {event.briefContent}
                              </div>
                            </div>
                          ) : event.client ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                generateBrief(event.client!.id, event.eventId || "");
                              }}
                              disabled={isGenerating || event.client.sessionCount === 0}
                              className="px-3 py-1.5 bg-accent text-white text-xs font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
                            >
                              {isGenerating
                                ? "Generating Brief..."
                                : event.client.sessionCount === 0
                                  ? "No session history for brief"
                                  : "Generate Prep Brief"}
                            </button>
                          ) : null}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChevronLeft({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
    </svg>
  );
}

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
    </svg>
  );
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
    </svg>
  );
}
