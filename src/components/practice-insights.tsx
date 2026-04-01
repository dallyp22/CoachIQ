"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface ClientInsight {
  clientId: string;
  clientName: string;
  avgClientTalk: number;
  avgQuestionRatio: number;
  avgOwnership: number;
  sessionCount: number;
}

interface PracticeData {
  practiceAverages: {
    clientTalkPercent: number;
    questionRatio: number;
    ownershipPercent: number;
  };
  clientCount: number;
  topTalkers: ClientInsight[];
  topQuestioners: ClientInsight[];
  topOwnership: ClientInsight[];
  lowOwnership: ClientInsight[];
}

export function PracticeInsights() {
  const [data, setData] = useState<PracticeData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/analytics/practice-insights")
      .then((r) => r.json())
      .then((d) => { if (d.practiceAverages) setData(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-6">
        <div className="h-6 bg-border/50 rounded w-48 mb-4 animate-pulse" />
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-border/30 rounded animate-pulse" />)}
        </div>
      </div>
    );
  }

  if (!data || data.clientCount === 0) return null;

  const { practiceAverages: avg } = data;

  return (
    <div className="bg-surface border border-border rounded-[var(--radius-lg)] p-6">
      <h2 className="font-display text-lg text-foreground mb-1">Coaching Patterns</h2>
      <p className="text-xs text-muted mb-5">
        Language analytics across {data.clientCount} clients with 3+ sessions
      </p>

      {/* Practice averages */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <GaugeCard
          label="Avg Client Talk Time"
          value={avg.clientTalkPercent}
          suffix="%"
          target={75}
          good={avg.clientTalkPercent >= 65 && avg.clientTalkPercent <= 85}
          description="Target: 70-80%"
        />
        <GaugeCard
          label="Avg Question Ratio"
          value={avg.questionRatio}
          suffix="%"
          description="Client questions as % of sentences"
        />
        <GaugeCard
          label="Avg Ownership Language"
          value={avg.ownershipPercent}
          suffix="%"
          good={avg.ownershipPercent > 55}
          description="I/we vs they/them pronouns"
        />
      </div>

      {/* Client leaderboards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <LeaderBoard
          title="Highest Client Talk Time"
          description="Clients driving the conversation"
          clients={data.topTalkers}
          metric={(c) => `${c.avgClientTalk}%`}
          good
        />
        <LeaderBoard
          title="Most Exploratory (Questions)"
          description="Clients asking the most questions"
          clients={data.topQuestioners}
          metric={(c) => `${c.avgQuestionRatio}%`}
          good
        />
        <LeaderBoard
          title="Strongest Ownership Language"
          description="Highest I/we vs they/them ratio"
          clients={data.topOwnership}
          metric={(c) => `${c.avgOwnership}%`}
          good
        />
        <LeaderBoard
          title="Watch: Low Ownership"
          description="May need support taking accountability"
          clients={data.lowOwnership}
          metric={(c) => `${c.avgOwnership}%`}
        />
      </div>
    </div>
  );
}

function GaugeCard({
  label,
  value,
  suffix,
  target,
  good,
  description,
}: {
  label: string;
  value: number;
  suffix: string;
  target?: number;
  good?: boolean;
  description?: string;
}) {
  return (
    <div className="border border-border rounded-[var(--radius-md)] p-4">
      <p className="text-[10px] font-mono uppercase tracking-wider text-muted mb-2">{label}</p>
      <div className="flex items-baseline gap-1">
        <span className="font-mono text-[28px] font-medium text-foreground leading-none">{value}</span>
        <span className="font-mono text-sm text-muted">{suffix}</span>
        {good !== undefined && (
          <span className={`ml-2 w-2 h-2 rounded-full ${good ? "bg-success" : "bg-warning"}`} />
        )}
      </div>
      {/* Simple bar gauge */}
      <div className="mt-2 h-1.5 bg-border/50 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${Math.min(100, value)}%` }}
        />
        {target && (
          <div
            className="relative h-3 w-px bg-foreground/30 -mt-[9px]"
            style={{ marginLeft: `${target}%` }}
          />
        )}
      </div>
      {description && <p className="text-[10px] text-muted mt-1.5">{description}</p>}
    </div>
  );
}

function LeaderBoard({
  title,
  description,
  clients,
  metric,
  good,
}: {
  title: string;
  description: string;
  clients: ClientInsight[];
  metric: (c: ClientInsight) => string;
  good?: boolean;
}) {
  return (
    <div className="border border-border rounded-[var(--radius-md)] p-4">
      <p className="text-xs font-medium text-foreground mb-0.5">{title}</p>
      <p className="text-[10px] text-muted mb-3">{description}</p>
      <div className="space-y-1.5">
        {clients.map((c, i) => (
          <div key={c.clientId} className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-muted w-4">{i + 1}.</span>
            <Link
              href={`/clients/${c.clientId}`}
              className="text-xs text-foreground hover:text-accent transition-colors flex-1 truncate"
            >
              {c.clientName}
            </Link>
            <span className={`font-mono text-xs font-medium ${good ? "text-success" : "text-warning"}`}>
              {metric(c)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
