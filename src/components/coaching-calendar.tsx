"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { DayBrief, type DayBriefData } from "@/components/day-brief";

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

// ─── Date helpers ─────────────────────────────────────────

function getToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
}

function formatDateLabel(dateStr: string): string {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}

function getWeekRange(dateStr: string): { start: string; end: string } {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay(); // 0=Sun
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(d);
  start.setDate(d.getDate() + mondayOffset);
  const end = new Date(start);
  end.setDate(start.getDate() + 6); // Sunday
  return { start: start.toLocaleDateString("en-CA"), end: end.toLocaleDateString("en-CA") };
}

function getWeekDays(dateStr: string): Array<{ date: string; dayName: string; dayNum: number }> {
  const { start } = getWeekRange(dateStr);
  const days: Array<{ date: string; dayName: string; dayNum: number }> = [];
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start + "T12:00:00");
    d.setDate(d.getDate() + i);
    days.push({
      date: d.toLocaleDateString("en-CA"),
      dayName: names[i],
      dayNum: d.getDate(),
    });
  }
  return days;
}

function getWeekLabel(dateStr: string): string {
  const { start, end } = getWeekRange(dateStr);
  const s = new Date(start + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const e = new Date(end + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${s} – ${e}`;
}

function getMonthRange(dateStr: string): { start: string; end: string } {
  const d = new Date(dateStr + "T12:00:00");
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { start: start.toLocaleDateString("en-CA"), end: end.toLocaleDateString("en-CA") };
}

function getMonthLabel(dateStr: string): string {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function getMonthGridCells(dateStr: string): Array<{ date: string; isCurrentMonth: boolean }> {
  const d = new Date(dateStr + "T12:00:00");
  const year = d.getFullYear();
  const month = d.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = new Date(year, month + 1, 0);

  // Start grid on Sunday before (or on) the 1st
  const startDay = firstOfMonth.getDay(); // 0=Sun
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(1 - startDay);

  const cells: Array<{ date: string; isCurrentMonth: boolean }> = [];
  const totalCells = 42; // 6 rows x 7 cols
  for (let i = 0; i < totalCells; i++) {
    const cell = new Date(gridStart);
    cell.setDate(gridStart.getDate() + i);
    cells.push({
      date: cell.toLocaleDateString("en-CA"),
      isCurrentMonth: cell.getMonth() === month,
    });
  }

  // Trim trailing row if all cells are next month
  const lastRowStart = cells.length - 7;
  if (cells[lastRowStart] && !cells[lastRowStart].isCurrentMonth) {
    cells.splice(lastRowStart, 7);
  }

  return cells;
}

function eventTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
  });
}

// ─── Main Component ───────────────────────────────────────

export function CoachingCalendar() {
  const [viewMode, setViewMode] = useState<ViewMode>("day");
  const [currentDate, setCurrentDate] = useState(getToday());
  const [days, setDays] = useState<DayData[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const [generatingBrief, setGeneratingBrief] = useState<Set<string>>(new Set());
  const [morningBrief, setMorningBrief] = useState<DayBriefData | null>(null);
  const [morningBriefLoading, setMorningBriefLoading] = useState(false);
  const [morningBriefExpanded, setMorningBriefExpanded] = useState(false);
  const [morningBriefError, setMorningBriefError] = useState<string | null>(null);

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

      const sortedDays: DayData[] = [...byDate.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, evts]) => ({ date, events: evts }));

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

  useEffect(() => { fetchEvents(); }, [fetchEvents]);

  function navigate(direction: -1 | 1) {
    if (viewMode === "day") setCurrentDate(addDays(currentDate, direction));
    else if (viewMode === "week") setCurrentDate(addDays(currentDate, direction * 7));
    else {
      const d = new Date(currentDate + "T12:00:00");
      d.setMonth(d.getMonth() + direction);
      setCurrentDate(d.toLocaleDateString("en-CA"));
    }
  }

  function goToDay(date: string) {
    setCurrentDate(date);
    setViewMode("day");
  }

  function toggleExpand(eventId: string) {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      next.has(eventId) ? next.delete(eventId) : next.add(eventId);
      return next;
    });
  }

  async function generateBrief(clientId: string, eventId: string) {
    setGeneratingBrief((prev) => new Set(prev).add(eventId));
    try {
      const resp = await fetch(`/api/clients/${clientId}/prep-brief`, { method: "POST" });
      if (resp.ok) {
        await fetchEvents();
        setExpandedEvents((prev) => new Set(prev).add(eventId));
      }
    } finally {
      setGeneratingBrief((prev) => { const n = new Set(prev); n.delete(eventId); return n; });
    }
  }

  async function handleMorningBrief() {
    if (morningBrief && !morningBriefLoading) {
      setMorningBriefExpanded(!morningBriefExpanded);
      return;
    }
    setMorningBriefLoading(true);
    setMorningBriefError(null);
    try {
      const resp = await fetch("/api/daily-brief");
      const data = await resp.json();
      if (data.brief) {
        setMorningBrief(data.brief);
        setMorningBriefExpanded(true);
      } else {
        setMorningBriefError(
          data.error ? String(data.error) : `Brief request failed (${resp.status})`
        );
        setMorningBriefExpanded(true);
      }
    } catch (err) {
      setMorningBriefError(err instanceof Error ? err.message : "Network error");
      setMorningBriefExpanded(true);
    } finally {
      setMorningBriefLoading(false);
    }
  }

  // Build event lookup by date
  const eventsByDate = new Map<string, CalendarEvent[]>();
  for (const day of days) {
    eventsByDate.set(day.date, day.events);
  }

  const allEvents = days.flatMap((d) => d.events);
  const totalBillableHrs = allEvents.reduce((s, e) => s + Math.ceil(e.durationMinutes / 15) * 0.25, 0);
  const today = getToday();

  const headerLabel = viewMode === "day"
    ? formatDateLabel(currentDate)
    : viewMode === "week"
      ? getWeekLabel(currentDate)
      : getMonthLabel(currentDate);

  return (
    <div className="mt-10 border-t border-border pt-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h2 className="font-display text-[22px] text-foreground">Coaching Schedule</h2>
        <div className="flex items-center gap-2">
          {viewMode === "day" && allEvents.length > 0 && (
            <button onClick={handleMorningBrief} disabled={morningBriefLoading}
              className="px-3 py-1.5 bg-accent text-white text-xs font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50">
              {morningBriefLoading ? "Generating..." : morningBrief ? (morningBriefExpanded ? "Hide Day Brief" : "Show Day Brief") : "Generate Day Brief"}
            </button>
          )}
          <div className="flex border border-border rounded overflow-hidden">
            {(["day", "week", "month"] as ViewMode[]).map((mode) => (
              <button key={mode} onClick={() => setViewMode(mode)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${viewMode === mode ? "bg-foreground text-background" : "bg-surface text-muted hover:text-foreground"}`}>
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Date nav */}
      <div className="flex items-center gap-3 mt-3">
        <button onClick={() => navigate(-1)} className="p-1.5 border border-border rounded hover:border-accent hover:text-accent transition-colors" aria-label="Previous">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button onClick={() => navigate(1)} className="p-1.5 border border-border rounded hover:border-accent hover:text-accent transition-colors" aria-label="Next">
          <ChevronRight className="w-4 h-4" />
        </button>
        <span className="text-sm font-medium text-foreground">{headerLabel}</span>
        {currentDate !== today && (
          <button onClick={() => setCurrentDate(today)} className="text-xs text-accent hover:underline font-medium">Today</button>
        )}
        {!loading && allEvents.length > 0 && (
          <span className="text-xs text-muted ml-auto">
            {allEvents.length} session{allEvents.length !== 1 ? "s" : ""} &middot; {totalBillableHrs.toFixed(1)} billable hrs
          </span>
        )}
      </div>

      {/* Morning brief */}
      {morningBriefExpanded && morningBrief && (
        <div className="mt-4">
          <DayBrief brief={morningBrief} />
        </div>
      )}
      {morningBriefExpanded && !morningBrief && morningBriefError && (
        <div className="mt-4 bg-surface border border-error/40 border-l-2 border-l-error rounded-r-md px-4 py-3">
          <div className="text-[11px] uppercase tracking-wider text-error font-medium">
            Day Brief failed
          </div>
          <p className="mt-1 text-sm text-foreground/85 leading-relaxed font-mono break-words">
            {morningBriefError}
          </p>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="mt-4 space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-20 bg-border/30 rounded animate-pulse" />)}
        </div>
      ) : viewMode === "day" ? (
        <DayView
          events={allEvents}
          expandedEvents={expandedEvents}
          generatingBrief={generatingBrief}
          onToggleExpand={toggleExpand}
          onGenerateBrief={generateBrief}
        />
      ) : viewMode === "week" ? (
        <WeekView
          currentDate={currentDate}
          eventsByDate={eventsByDate}
          today={today}
          onDayClick={goToDay}
        />
      ) : (
        <MonthView
          currentDate={currentDate}
          eventsByDate={eventsByDate}
          today={today}
          onDayClick={goToDay}
        />
      )}
    </div>
  );
}

// ─── Day View ─────────────────────────────────────────────

function DayView({
  events, expandedEvents, generatingBrief, onToggleExpand, onGenerateBrief,
}: {
  events: CalendarEvent[];
  expandedEvents: Set<string>;
  generatingBrief: Set<string>;
  onToggleExpand: (id: string) => void;
  onGenerateBrief: (clientId: string, eventId: string) => void;
}) {
  if (events.length === 0) {
    return <p className="text-sm text-muted mt-4">No coaching sessions scheduled for this day.</p>;
  }

  return (
    <div className="mt-4 space-y-2">
      {events.map((event) => {
        const isExpanded = expandedEvents.has(event.eventId || "");
        const isGenerating = generatingBrief.has(event.eventId || "");
        const startTime = event.start ? eventTime(event.start) : "";
        const endTime = event.end ? eventTime(event.end) : "";

        return (
          <div key={event.eventId}
            className={`bg-surface border rounded-[var(--radius-md)] transition-colors ${isExpanded ? "border-accent/40" : "border-border hover:border-border/80"}`}>
            <button onClick={() => onToggleExpand(event.eventId || "")} className="w-full text-left p-4 cursor-pointer">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-accent font-medium">{startTime}</span>
                    <span className="text-xs text-muted">–</span>
                    <span className="font-mono text-xs text-muted">{endTime}</span>
                  </div>
                  <p className="text-sm font-medium text-foreground mt-1">
                    {event.client ? (
                      <>{event.client.name}{event.client.company && <span className="text-muted font-normal"> — {event.client.company}</span>}</>
                    ) : event.title}
                  </p>
                  {!isExpanded && event.synopsisPreview && (
                    <p className="text-xs text-muted mt-1 line-clamp-1 italic">{event.synopsisPreview}</p>
                  )}
                  {!isExpanded && event.briefContent && (
                    <span className="inline-block mt-1 text-[10px] font-mono uppercase tracking-wider text-success">Brief ready</span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono text-xs text-muted bg-background border border-border px-2 py-0.5 rounded">{event.durationMinutes} min</span>
                  <ChevronDown className={`w-4 h-4 text-muted transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                </div>
              </div>
            </button>

            {isExpanded && (
              <div className="px-4 pb-4 border-t border-border/50 pt-3 space-y-3">
                {event.client && (
                  <div className="flex items-center gap-4 text-xs text-muted">
                    <span className="font-mono">{event.client.sessionCount} sessions</span>
                    <span className="font-mono">{event.client.meetingCadence.charAt(0) + event.client.meetingCadence.slice(1).toLowerCase()} cadence</span>
                    <Link href={`/clients/${event.client.id}`} className="text-accent hover:underline ml-auto" onClick={(e) => e.stopPropagation()}>View Dossier</Link>
                  </div>
                )}
                {event.lastSynopsis && (
                  <div>
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted mb-1">Last Session</p>
                    <p className="text-sm text-foreground/80 leading-relaxed">{event.lastSynopsis}</p>
                  </div>
                )}
                {event.actionItems.length > 0 && (
                  <div>
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted mb-1">Open Action Items</p>
                    <ul className="space-y-1">
                      {event.actionItems.map((item, i) => (
                        <li key={i} className="text-sm text-foreground/80 flex gap-2">
                          <span className="text-accent shrink-0">•</span>{item.description}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {event.briefContent ? (
                  <div>
                    <p className="text-[10px] font-mono uppercase tracking-wider text-success mb-1">Prep Brief</p>
                    <div className="bg-background border border-border rounded p-3 text-sm text-foreground/80 leading-relaxed whitespace-pre-line [&_strong]:font-semibold [&_strong]:text-foreground">
                      {event.briefContent}
                    </div>
                  </div>
                ) : event.client ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); onGenerateBrief(event.client!.id, event.eventId || ""); }}
                    disabled={isGenerating || event.client.sessionCount === 0}
                    className="px-3 py-1.5 bg-accent text-white text-xs font-medium rounded hover:bg-accent-hover transition-colors disabled:opacity-50">
                    {isGenerating ? "Generating Brief..." : event.client.sessionCount === 0 ? "No session history for brief" : "Generate Prep Brief"}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Week View (7-column grid) ────────────────────────────

function WeekView({
  currentDate, eventsByDate, today, onDayClick,
}: {
  currentDate: string;
  eventsByDate: Map<string, CalendarEvent[]>;
  today: string;
  onDayClick: (date: string) => void;
}) {
  const weekDays = getWeekDays(currentDate);

  return (
    <div className="mt-4 grid grid-cols-7 gap-px bg-border rounded-[var(--radius-md)] overflow-hidden border border-border">
      {weekDays.map((day) => {
        const events = eventsByDate.get(day.date) || [];
        const isToday = day.date === today;
        const isWeekend = day.dayName === "Sat" || day.dayName === "Sun";

        return (
          <div key={day.date}
            className={`bg-surface min-h-[140px] flex flex-col ${isWeekend ? "bg-background" : ""}`}>
            {/* Column header */}
            <button
              onClick={() => onDayClick(day.date)}
              className="p-2 text-center border-b border-border hover:bg-border/20 transition-colors"
            >
              <span className={`text-[10px] uppercase tracking-wider block ${isToday ? "text-accent font-semibold" : "text-muted"}`}>
                {day.dayName}
              </span>
              <span className={`font-mono text-sm block mt-0.5 ${
                isToday
                  ? "bg-accent text-white w-7 h-7 rounded-full inline-flex items-center justify-center leading-none"
                  : "text-foreground"
              }`}>
                {day.dayNum}
              </span>
            </button>

            {/* Events */}
            <div className="flex-1 p-1 space-y-1">
              {events.map((event) => (
                <button
                  key={event.eventId}
                  onClick={() => onDayClick(day.date)}
                  className="w-full text-left p-1.5 rounded bg-accent/5 border border-accent/15 hover:bg-accent/10 transition-colors cursor-pointer"
                >
                  <span className="font-mono text-[10px] text-accent block">
                    {event.start ? eventTime(event.start) : ""}
                  </span>
                  <span className="text-xs text-foreground font-medium block truncate">
                    {event.client?.name || event.title}
                  </span>
                  {event.briefContent && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-success mt-0.5" title="Brief ready" />
                  )}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Month View (calendar grid) ───────────────────────────

function MonthView({
  currentDate, eventsByDate, today, onDayClick,
}: {
  currentDate: string;
  eventsByDate: Map<string, CalendarEvent[]>;
  today: string;
  onDayClick: (date: string) => void;
}) {
  const cells = getMonthGridCells(currentDate);
  const dayHeaders = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="mt-4">
      {/* Day-of-week header */}
      <div className="grid grid-cols-7 gap-px bg-border rounded-t-[var(--radius-md)] overflow-hidden border border-b-0 border-border">
        {dayHeaders.map((name) => (
          <div key={name} className="bg-surface py-2 text-center">
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted">{name}</span>
          </div>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-7 gap-px bg-border rounded-b-[var(--radius-md)] overflow-hidden border border-t-0 border-border">
        {cells.map((cell) => {
          const events = eventsByDate.get(cell.date) || [];
          const isToday = cell.date === today;
          const dayNum = new Date(cell.date + "T12:00:00").getDate();
          const hasEvents = events.length > 0;

          return (
            <button
              key={cell.date}
              onClick={() => onDayClick(cell.date)}
              className={`min-h-[90px] p-1.5 text-left flex flex-col transition-colors cursor-pointer hover:bg-border/20 ${
                cell.isCurrentMonth ? "bg-surface" : "bg-background"
              } ${hasEvents ? "bg-accent/[0.02]" : ""}`}
            >
              {/* Day number */}
              <span className={`text-xs font-mono self-end ${
                !cell.isCurrentMonth
                  ? "text-muted/40"
                  : isToday
                    ? "bg-accent text-white w-6 h-6 rounded-full inline-flex items-center justify-center font-semibold"
                    : "text-foreground"
              }`}>
                {dayNum}
              </span>

              {/* Session pills */}
              <div className="mt-1 space-y-0.5 flex-1">
                {events.slice(0, 3).map((event) => (
                  <div key={event.eventId}
                    className={`flex items-center gap-1 px-1 py-0.5 rounded text-[10px] truncate ${
                      cell.isCurrentMonth ? "bg-accent/8 text-foreground" : "bg-border/30 text-muted"
                    }`}>
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${event.briefContent ? "bg-success" : "bg-accent"}`} />
                    <span className="truncate">
                      {event.client?.name.split(" ")[0] || event.title}
                    </span>
                    <span className="font-mono text-muted ml-auto shrink-0">
                      {event.start ? new Date(event.start).toLocaleTimeString("en-US", { hour: "numeric", timeZone: "America/Chicago" }).replace(" ", "") : ""}
                    </span>
                  </div>
                ))}
                {events.length > 3 && (
                  <span className="text-[10px] text-muted pl-1">+{events.length - 3} more</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Icons ────────────────────────────────────────────────

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
