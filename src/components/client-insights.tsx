"use client";

import { useState, useEffect } from "react";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";

interface SessionMetric {
  sessionId: string;
  date: string;
  title: string;
  clientTalkPercent: number;
  coachTalkPercent: number;
  totalTurns: number;
  clientTurns: number;
  coachTurns: number;
  clientWordCount: number;
  coachWordCount: number;
  questionRatio: number;
  pronounOwnership: number;
  lexicalDiversity: number;
  topicSimilarity: number | null;
}

interface MetricsData {
  clientId: string;
  sessionCount: number;
  metrics: SessionMetric[];
  averages: {
    clientTalkPercent: number;
    questionRatio: number;
    pronounOwnership: number;
    lexicalDiversity: number;
  };
}

export function ClientInsights({ clientId, clientName }: { clientId: string; clientName: string }) {
  const [data, setData] = useState<MetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetch(`/api/analytics/session-metrics?clientId=${clientId}`)
      .then((r) => r.json())
      .then((d) => { if (d.metrics) setData(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [clientId]);

  if (loading) return null;
  if (!data || data.sessionCount < 3) return null;

  const chartData = data.metrics.map((m) => ({
    date: new Date(m.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    fullDate: new Date(m.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    clientTalk: m.clientTalkPercent,
    coachTalk: m.coachTalkPercent,
    questionRatio: m.questionRatio,
    ownership: Math.round(m.pronounOwnership * 100),
    lexical: +(m.lexicalDiversity * 10).toFixed(1), // Scale for readability
    topicSim: m.topicSimilarity !== null ? Math.round(m.topicSimilarity * 100) : null,
    title: m.title,
  }));

  const firstName = clientName.split(" ")[0];
  const { averages } = data;

  // Trend detection: compare first third vs last third
  const third = Math.max(1, Math.floor(data.metrics.length / 3));
  const firstThird = data.metrics.slice(0, third);
  const lastThird = data.metrics.slice(-third);

  const avgFirst = (arr: SessionMetric[], fn: (m: SessionMetric) => number) =>
    arr.reduce((s, m) => s + fn(m), 0) / arr.length;

  const talkTrend = avgFirst(lastThird, (m) => m.clientTalkPercent) - avgFirst(firstThird, (m) => m.clientTalkPercent);
  const questionTrend = avgFirst(lastThird, (m) => m.questionRatio) - avgFirst(firstThird, (m) => m.questionRatio);
  const ownershipTrend = avgFirst(lastThird, (m) => m.pronounOwnership) - avgFirst(firstThird, (m) => m.pronounOwnership);

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display text-xl text-foreground">Coaching Insights</h2>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-accent hover:underline font-medium"
        >
          {expanded ? "Collapse" : "View Details"}
        </button>
      </div>

      {/* Compact sparkline row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard
          label="Client Talk Time"
          value={`${averages.clientTalkPercent}%`}
          target="70-80%"
          trend={talkTrend}
          good={averages.clientTalkPercent >= 65}
        >
          <MiniSparkline data={chartData} dataKey="clientTalk" color="var(--accent)" />
        </MetricCard>

        <MetricCard
          label="Question Ratio"
          value={`${averages.questionRatio}%`}
          trend={questionTrend}
          good={averages.questionRatio > 15}
          description="% of client sentences as questions"
        >
          <MiniSparkline data={chartData} dataKey="questionRatio" color="var(--foreground)" />
        </MetricCard>

        <MetricCard
          label="Ownership Language"
          value={`${Math.round(averages.pronounOwnership * 100)}%`}
          trend={ownershipTrend * 100}
          good={averages.pronounOwnership > 0.5}
          description="I/we vs they/them ratio"
        >
          <MiniSparkline data={chartData} dataKey="ownership" color="#16A34A" />
        </MetricCard>

        <MetricCard
          label="Topic Consistency"
          value={
            chartData.filter((d) => d.topicSim !== null).length > 0
              ? `${Math.round(chartData.filter((d) => d.topicSim !== null).reduce((s, d) => s + d.topicSim!, 0) / chartData.filter((d) => d.topicSim !== null).length)}%`
              : "—"
          }
          description="Session-to-session similarity"
        >
          <MiniSparkline
            data={chartData.filter((d) => d.topicSim !== null)}
            dataKey="topicSim"
            color="#2563EB"
          />
        </MetricCard>
      </div>

      {/* Expanded detail charts */}
      {expanded && (
        <div className="mt-6 space-y-6">
          {/* Talk Time Area Chart */}
          <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-5">
            <h3 className="text-sm font-medium text-foreground mb-1">
              Talk Time Distribution
            </h3>
            <p className="text-xs text-muted mb-4">
              {firstName}&apos;s share of conversation vs Todd. Target: 70-80% client talk time.
            </p>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--muted)" }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--muted)" }} tickFormatter={(v) => `${v}%`} />
                <Tooltip
                  contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", fontSize: 12 }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(value: any, name: any) => [`${value}%`, name === "clientTalk" ? firstName : "Todd"]}
                  labelFormatter={(_, payload) => payload?.[0]?.payload?.fullDate || ""}
                />
                <ReferenceLine y={75} stroke="var(--accent)" strokeDasharray="3 3" strokeOpacity={0.5} />
                <Area type="monotone" dataKey="clientTalk" stackId="1" fill="var(--accent)" fillOpacity={0.15} stroke="var(--accent)" strokeWidth={2} />
                <Area type="monotone" dataKey="coachTalk" stackId="1" fill="var(--muted)" fillOpacity={0.08} stroke="var(--muted)" strokeWidth={1} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Question Ratio + Ownership */}
          <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-5">
            <h3 className="text-sm font-medium text-foreground mb-1">
              Language Patterns
            </h3>
            <p className="text-xs text-muted mb-4">
              Question ratio (exploratory thinking) and ownership language (I/we vs they/them).
              Rising questions often signal a growth phase. Rising ownership signals accountability.
            </p>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--muted)" }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--muted)" }} tickFormatter={(v) => `${v}%`} />
                <Tooltip
                  contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", fontSize: 12 }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(value: any, name: any) => [
                    `${value}%`,
                    name === "questionRatio" ? "Questions" : "Ownership",
                  ]}
                  labelFormatter={(_, payload) => payload?.[0]?.payload?.fullDate || ""}
                />
                <Line type="monotone" dataKey="questionRatio" stroke="var(--foreground)" strokeWidth={2} dot={{ r: 2 }} />
                <Line type="monotone" dataKey="ownership" stroke="#16A34A" strokeWidth={2} dot={{ r: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Topic Drift */}
          {chartData.some((d) => d.topicSim !== null) && (
            <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-5">
              <h3 className="text-sm font-medium text-foreground mb-1">
                Topic Consistency
              </h3>
              <p className="text-xs text-muted mb-4">
                Cosine similarity between consecutive session transcripts.
                High = revisiting similar themes. Low = exploring new territory.
                Sustained low similarity may indicate avoidance or rapid growth.
              </p>
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={chartData.filter((d) => d.topicSim !== null)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--muted)" }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--muted)" }} tickFormatter={(v) => `${v}%`} />
                  <Tooltip
                    contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", fontSize: 12 }}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    formatter={(value: any) => [`${value}%`, "Similarity"]}
                    labelFormatter={(_, payload) => payload?.[0]?.payload?.fullDate || ""}
                  />
                  <Area type="monotone" dataKey="topicSim" fill="#2563EB" fillOpacity={0.1} stroke="#2563EB" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────

function MetricCard({
  label,
  value,
  target,
  trend,
  good,
  description,
  children,
}: {
  label: string;
  value: string;
  target?: string;
  trend?: number;
  good?: boolean;
  description?: string;
  children: React.ReactNode;
}) {
  const trendLabel = trend
    ? trend > 2
      ? "trending up"
      : trend < -2
        ? "trending down"
        : "stable"
    : undefined;

  return (
    <div className="bg-surface border border-border rounded-[var(--radius-md)] p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted">{label}</span>
        {good !== undefined && (
          <span className={`w-2 h-2 rounded-full ${good ? "bg-success" : "bg-warning"}`} />
        )}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-lg font-medium text-foreground">{value}</span>
        {target && <span className="text-[10px] text-muted">target {target}</span>}
      </div>
      {trendLabel && (
        <span className={`text-[10px] ${
          trendLabel === "trending up" ? "text-success" : trendLabel === "trending down" ? "text-error" : "text-muted"
        }`}>
          {trend! > 0 ? "+" : ""}{Math.round(trend!)}pp {trendLabel}
        </span>
      )}
      {description && <p className="text-[10px] text-muted mt-0.5">{description}</p>}
      <div className="mt-2 h-[40px]">{children}</div>
    </div>
  );
}

function MiniSparkline({
  data,
  dataKey,
  color,
}: {
  data: Array<Record<string, unknown>>;
  dataKey: string;
  color: string;
}) {
  if (data.length < 2) return <div className="h-full bg-border/20 rounded" />;

  return (
    <ResponsiveContainer width="100%" height={40}>
      <LineChart data={data}>
        <Line
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
