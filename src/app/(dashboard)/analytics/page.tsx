"use client";

import { useState, useEffect } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  LineChart,
  Line,
} from "recharts";
import { WordCloudSection } from "@/components/word-cloud";
import { PracticeInsights } from "@/components/practice-insights";

interface AnalyticsData {
  monthlyData: Array<{
    month: string;
    label: string;
    sessions: number;
    hours: number;
    revenue: number;
  }>;
  topClientsData: Array<{
    name: string;
    fullName: string;
    sessions: number;
    revenue: number;
  }>;
  stats: {
    totalClients: number;
    totalSessions: number;
    totalTranscripts: number;
    totalBilled: number;
    totalPaid: number;
    totalUnbilled: number;
    avgSessionsPerClient: number;
    clientsWithSessions: number;
  };
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [privacy, setPrivacy] = useState(false);

  useEffect(() => {
    fetch("/api/analytics")
      .then((r) => r.json())
      .then(setData);
  }, []);

  if (!data) {
    return (
      <div className="animate-pulse">
        <div className="h-8 bg-border/50 rounded w-48 mb-8" />
        <div className="grid grid-cols-4 gap-4 mb-8">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-border/30 rounded" />
          ))}
        </div>
        <div className="h-64 bg-border/30 rounded" />
      </div>
    );
  }

  const { monthlyData, topClientsData, stats } = data;

  // Apply privacy mode to chart data
  const displayClientsData = privacy
    ? topClientsData.map((c, i) => ({
        ...c,
        name: `Client ${i + 1}`,
        fullName: `Client ${i + 1}`,
      }))
    : topClientsData;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-[32px] text-foreground">Analytics</h1>
          <p className="text-sm text-muted mt-1">
            Practice performance across {stats.clientsWithSessions} active clients
          </p>
        </div>
        <button
          onClick={() => setPrivacy(!privacy)}
          className={`flex items-center gap-2 px-3 py-1.5 border rounded text-xs font-medium transition-colors ${
            privacy
              ? "bg-foreground text-background border-foreground"
              : "bg-surface text-muted border-border hover:border-foreground hover:text-foreground"
          }`}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            {privacy ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            )}
          </svg>
          Privacy {privacy ? "On" : "Off"}
        </button>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-8">
        <StatCard label="Total Sessions" value={String(stats.totalSessions)} />
        <StatCard
          label="Avg Sessions/Client"
          value={String(stats.avgSessionsPerClient)}
        />
        <StatCard
          label="Total Billed"
          value={`$${stats.totalBilled.toLocaleString()}`}
        />
        <StatCard
          label="Unbilled"
          value={`$${stats.totalUnbilled.toLocaleString()}`}
          accent
        />
      </div>

      {/* Sessions & Revenue Over Time */}
      <div className="mt-10 bg-surface border border-border rounded-[var(--radius-lg)] p-6">
        <h2 className="font-display text-lg text-foreground mb-1">
          Sessions Over Time
        </h2>
        <p className="text-xs text-muted mb-6">Monthly session count and estimated revenue</p>

        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={monthlyData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 12, fill: "var(--muted)" }}
              axisLine={{ stroke: "var(--border)" }}
            />
            <YAxis
              yAxisId="sessions"
              tick={{ fontSize: 12, fill: "var(--muted)" }}
              axisLine={{ stroke: "var(--border)" }}
            />
            <YAxis
              yAxisId="revenue"
              orientation="right"
              tick={{ fontSize: 12, fill: "var(--muted)" }}
              axisLine={{ stroke: "var(--border)" }}
              tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
            />
            <Tooltip
              contentStyle={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
                fontSize: 13,
              }}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatter={(value: any, name: any) =>
                name === "revenue"
                  ? [`$${Number(value).toLocaleString()}`, "Revenue"]
                  : [String(value), "Sessions"]
              }
            />
            <Line
              yAxisId="sessions"
              type="monotone"
              dataKey="sessions"
              stroke="var(--foreground)"
              strokeWidth={2}
              dot={{ r: 3, fill: "var(--foreground)" }}
            />
            <Line
              yAxisId="revenue"
              type="monotone"
              dataKey="revenue"
              stroke="var(--accent)"
              strokeWidth={2}
              dot={{ r: 3, fill: "var(--accent)" }}
              strokeDasharray="5 5"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Top Clients */}
      <div className="mt-8 bg-surface border border-border rounded-[var(--radius-lg)] p-6">
        <h2 className="font-display text-lg text-foreground mb-1">
          Top Clients by Sessions
        </h2>
        <p className="text-xs text-muted mb-6">Most active coaching relationships</p>

        <ResponsiveContainer width="100%" height={400}>
          <BarChart data={displayClientsData} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 12, fill: "var(--muted)" }}
              axisLine={{ stroke: "var(--border)" }}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 12, fill: "var(--foreground)" }}
              axisLine={{ stroke: "var(--border)" }}
              width={80}
            />
            <Tooltip
              contentStyle={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
                fontSize: 13,
              }}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatter={(value: any, name: any) =>
                name === "revenue"
                  ? [`$${Number(value).toLocaleString()}`, "Est. Revenue"]
                  : [String(value), "Sessions"]
              }
              labelFormatter={(label) => {
                const client = displayClientsData.find((c) => c.name === label);
                return client?.fullName || label;
              }}
            />
            <Bar dataKey="sessions" fill="var(--accent)" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Coaching Patterns */}
      <div className="mt-8">
        <PracticeInsights privacy={privacy} />
      </div>

      {/* Word Cloud */}
      <div className="mt-8">
        <WordCloudSection />
      </div>

      {/* Practice Health */}
      <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-6">
          <h3 className="font-display text-base text-foreground mb-3">Coverage</h3>
          <div className="space-y-2">
            <InfoRow label="Active Clients" value={String(stats.totalClients)} />
            <InfoRow label="With Sessions" value={String(stats.clientsWithSessions)} />
            <InfoRow label="Transcripts" value={String(stats.totalTranscripts)} />
          </div>
        </div>
        <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-6">
          <h3 className="font-display text-base text-foreground mb-3">Billing</h3>
          <div className="space-y-2">
            <InfoRow label="Total Billed" value={`$${stats.totalBilled.toLocaleString()}`} />
            <InfoRow label="Collected" value={`$${stats.totalPaid.toLocaleString()}`} />
            <InfoRow label="Outstanding" value={`$${stats.totalUnbilled.toLocaleString()}`} accent />
          </div>
        </div>
        <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-6">
          <h3 className="font-display text-base text-foreground mb-3">Intelligence</h3>
          <div className="space-y-2">
            <InfoRow label="Transcripts" value={String(stats.totalTranscripts)} />
            <InfoRow label="Synopses Generated" value={String(stats.totalSessions)} />
            <InfoRow label="Avg Sessions/Client" value={String(stats.avgSessionsPerClient)} />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-surface border border-border rounded-[var(--radius-md)] p-5">
      <p className="text-xs text-muted uppercase tracking-wide font-medium">{label}</p>
      <p className={`font-mono text-[28px] font-medium mt-2 leading-none ${accent ? "text-accent" : "text-foreground"}`}>
        {value}
      </p>
    </div>
  );
}

function InfoRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-sm text-muted">{label}</span>
      <span className={`font-mono text-sm font-medium ${accent ? "text-accent" : "text-foreground"}`}>
        {value}
      </span>
    </div>
  );
}
