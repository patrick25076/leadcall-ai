"use client";

import { useState, useEffect } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "";

type Call = Record<string, unknown>;
type Lead = Record<string, unknown>;
type Agent = Record<string, unknown>;

type Analytics = {
  calls: { total: number; completed: number; in_progress: number; failed: number; answer_rate: number };
  duration: { average_seconds: number; total_seconds: number; total_minutes: number };
  outcomes: { meetings_booked: number; interested: number; meeting_rate: number; interest_rate: number };
  objections: string[];
  leads: { total: number; grade_distribution: Record<string, number> };
};

interface ResultsDashboardProps {
  calls: Call[];
  leads: Lead[];
  agents: Agent[];
  campaignId?: number;
}

export default function ResultsDashboard({ calls, leads, agents, campaignId }: ResultsDashboardProps) {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [expandedCall, setExpandedCall] = useState<number | null>(null);

  useEffect(() => {
    if (!campaignId) return;
    fetch(`${API}/api/campaigns/${campaignId}/analytics`)
      .then((r) => r.json())
      .then((data) => {
        if (data.analytics) setAnalytics(data.analytics);
      })
      .catch(() => {});
  }, [campaignId, calls.length]);

  const completed = calls.filter((c) => c.status === "completed");

  if (calls.length === 0 && !analytics) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-zinc-800/50 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
            </svg>
          </div>
          <p className="text-zinc-400 text-lg mb-2">No results yet</p>
          <p className="text-zinc-600 text-sm">Results will appear here after calls are made.</p>
        </div>
      </div>
    );
  }

  const stats = analytics?.calls || {
    total: calls.length,
    completed: completed.length,
    in_progress: calls.filter((c) => c.status === "initiated" || c.status === "ringing").length,
    failed: calls.filter((c) => c.status === "failed" || c.status === "no-answer").length,
    answer_rate: calls.length ? Math.round(completed.length / calls.length * 100) : 0,
  };

  const outcomes = analytics?.outcomes || { meetings_booked: 0, interested: 0, meeting_rate: 0, interest_rate: 0 };
  const duration = analytics?.duration || { average_seconds: 0, total_minutes: 0, total_seconds: 0 };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard label="Total Calls" value={String(stats.total)} />
          <MetricCard label="Completed" value={String(stats.completed)} accent="emerald" />
          <MetricCard label="Answer Rate" value={`${stats.answer_rate}%`} accent="blue" />
          <MetricCard label="Avg Duration" value={formatDuration(duration.average_seconds)} accent="purple" />
        </div>

        {/* Outcomes */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard label="Meetings Booked" value={String(outcomes.meetings_booked)} accent="emerald" />
          <MetricCard label="Interested Leads" value={String(outcomes.interested)} accent="blue" />
          <MetricCard label="Meeting Rate" value={`${outcomes.meeting_rate}%`} accent="amber" />
          <MetricCard label="Total Call Time" value={`${duration.total_minutes}m`} />
        </div>

        {/* Objections Summary */}
        {analytics?.objections && analytics.objections.length > 0 ? (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
            <h3 className="text-white font-medium mb-3">Common Objections</h3>
            <div className="space-y-2">
              {analytics.objections.map((obj, i) => (
                <div key={i} className="text-sm text-zinc-400 bg-zinc-800/30 rounded-lg px-3 py-2">
                  {obj}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Call History */}
        <div>
          <h3 className="text-white font-medium mb-4">Call History</h3>
          <div className="space-y-3">
            {calls.map((call, i) => {
              const analysis = call.analysis as Record<string, unknown> | undefined;
              const transcript = call.transcript as Array<Record<string, string>> | undefined;
              const evalRaw = analysis?.evaluation_results;
              const evaluation = (typeof evalRaw === "object" && evalRaw !== null) ? evalRaw as Record<string, unknown> : undefined;
              const collected: Record<string, unknown> | null = (() => {
                const raw = analysis?.collected_data;
                return (typeof raw === "object" && raw !== null) ? raw as Record<string, unknown> : null;
              })();
              const recordingUrl = call.recording_url as string | undefined;
              const isExpanded = expandedCall === i;

              const statusColor: Record<string, string> = {
                completed: "bg-emerald-500/20 text-emerald-400",
                initiated: "bg-amber-500/20 text-amber-400",
                ringing: "bg-blue-500/20 text-blue-400",
                "in-progress": "bg-blue-500/20 text-blue-400",
                failed: "bg-red-500/20 text-red-400",
                "no-answer": "bg-zinc-700/50 text-zinc-400",
              };

              return (
                <div key={i} className="bg-zinc-900/60 border border-zinc-800 rounded-xl overflow-hidden">
                  {/* Header */}
                  <button
                    onClick={() => setExpandedCall(isExpanded ? null : i)}
                    className="w-full text-left p-5 hover:bg-zinc-800/20 transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <div className="flex-1">
                        <p className="text-white font-medium">
                          {String(call.lead_name || call.phone_number || `Call #${i + 1}`)}
                        </p>
                        <p className="text-zinc-500 text-xs">
                          {String(call.phone_number || "Unknown number")}
                          {call.duration_seconds ? ` · ${formatDuration(Number(call.duration_seconds))}` : ""}
                          {call.duration_secs ? ` · ${formatDuration(Number(call.duration_secs))}` : ""}
                        </p>
                      </div>

                      {/* Quick analysis badges */}
                      {evaluation?.lead_interest ? (
                        <InterestBadge level={String(evaluation.lead_interest)} />
                      ) : null}
                      {collected?.meeting_booked ? (
                        <span className="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-1 rounded-full">
                          Meeting booked
                        </span>
                      ) : null}

                      <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                        statusColor[String(call.status)] || statusColor.initiated
                      }`}>
                        {String(call.status || "unknown")}
                      </span>

                      <svg
                        className={`w-4 h-4 text-zinc-500 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </button>

                  {/* Expanded Details */}
                  {isExpanded ? (
                    <div className="border-t border-zinc-800 p-5 space-y-4">
                      {/* Recording Playback */}
                      {recordingUrl ? (
                        <div>
                          <p className="text-xs text-zinc-500 mb-2">Recording</p>
                          <audio controls className="w-full h-10" preload="none">
                            <source src={recordingUrl} type="audio/mpeg" />
                            Your browser does not support audio playback.
                          </audio>
                        </div>
                      ) : null}

                      {/* Analysis Results */}
                      {evaluation ? (
                        <div>
                          <p className="text-xs text-zinc-500 mb-2">Analysis</p>
                          <div className="flex gap-4 flex-wrap">
                            {evaluation.objective_met ? (
                              <ResultBadge label="Objective" value={String(evaluation.objective_met)} />
                            ) : null}
                            {evaluation.lead_interest ? (
                              <ResultBadge label="Interest" value={String(evaluation.lead_interest)} />
                            ) : null}
                            {evaluation.objection_handling ? (
                              <ResultBadge label="Objections" value={String(evaluation.objection_handling)} />
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      {/* Collected Data */}
                      {collected ? (
                        <div>
                          <p className="text-xs text-zinc-500 mb-2">Data Collected</p>
                          <div className="flex flex-wrap gap-2">
                            {collected.meeting_booked != null && (
                              <span className="text-xs bg-emerald-500/10 text-emerald-400 px-2 py-1 rounded">
                                Meeting: {String(collected.meeting_booked)}
                              </span>
                            )}
                            {collected.callback_requested != null && String(collected.callback_requested) !== "" && (
                              <span className="text-xs bg-amber-500/10 text-amber-400 px-2 py-1 rounded">
                                Callback: {String(collected.callback_requested)}
                              </span>
                            )}
                            {collected.lead_budget != null && String(collected.lead_budget) !== "" && (
                              <span className="text-xs bg-blue-500/10 text-blue-400 px-2 py-1 rounded">
                                Budget: {String(collected.lead_budget)}
                              </span>
                            )}
                            {collected.decision_maker != null && String(collected.decision_maker) !== "" && (
                              <span className="text-xs bg-purple-500/10 text-purple-400 px-2 py-1 rounded">
                                Decision Maker: {String(collected.decision_maker)}
                              </span>
                            )}
                            {collected.competitor_mentioned != null && String(collected.competitor_mentioned) !== "" && (
                              <span className="text-xs bg-red-500/10 text-red-400 px-2 py-1 rounded">
                                Competitor: {String(collected.competitor_mentioned)}
                              </span>
                            )}
                            {collected.lead_objections != null && String(collected.lead_objections) !== "" && (
                              <span className="text-xs bg-zinc-700/50 text-zinc-400 px-2 py-1 rounded">
                                Objections: {String(collected.lead_objections).slice(0, 80)}
                              </span>
                            )}
                          </div>
                        </div>
                      ) : null}

                      {/* Summary */}
                      {analysis?.summary ? (
                        <div>
                          <p className="text-xs text-zinc-500 mb-1">Summary</p>
                          <p className="text-sm text-zinc-400">{String(analysis.summary)}</p>
                        </div>
                      ) : null}

                      {/* Transcript */}
                      {transcript && transcript.length > 0 ? (
                        <div>
                          <p className="text-xs text-zinc-500 mb-2">Transcript ({transcript.length} messages)</p>
                          <div className="space-y-1 max-h-60 overflow-y-auto bg-zinc-800/20 rounded-lg p-3">
                            {transcript.map((t, j) => (
                              <div key={j} className="text-xs">
                                <span className={`font-medium ${t.role === "agent" ? "text-emerald-500" : "text-blue-400"}`}>
                                  {t.role === "agent" ? "Agent" : "Lead"}:
                                </span>{" "}
                                <span className="text-zinc-400">{t.message}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  const accentColors: Record<string, string> = {
    emerald: "text-emerald-400",
    blue: "text-blue-400",
    amber: "text-amber-400",
    purple: "text-purple-400",
  };
  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
      <p className={`text-2xl font-bold ${accent ? accentColors[accent] || "text-white" : "text-white"}`}>
        {value}
      </p>
      <p className="text-xs text-zinc-500 mt-1">{label}</p>
    </div>
  );
}

function InterestBadge({ level }: { level: string }) {
  const colors: Record<string, string> = {
    high: "bg-emerald-500/20 text-emerald-400",
    medium: "bg-amber-500/20 text-amber-400",
    low: "bg-zinc-700/50 text-zinc-400",
  };
  return (
    <span className={`text-xs px-2 py-1 rounded-full ${colors[level.toLowerCase()] || colors.low}`}>
      {level} interest
    </span>
  );
}

function ResultBadge({ label, value }: { label: string; value: string }) {
  const v = String(value).toLowerCase();
  const isGood = v === "yes" || v === "high" || v === "excellent" || v === "true";
  const isMedium = v === "medium" || v === "moderate" || v === "partial";
  return (
    <div className="text-xs bg-zinc-800/40 rounded px-2 py-1">
      <span className="text-zinc-500">{label}: </span>
      <span className={isGood ? "text-emerald-400" : isMedium ? "text-amber-400" : "text-zinc-400"}>
        {value}
      </span>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!seconds) return "0s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
