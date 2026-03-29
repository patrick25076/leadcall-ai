"use client";

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";

const API = process.env.NEXT_PUBLIC_API_URL || "";

// Admin emails allowed to access this page
const ADMIN_EMAILS = ["patrickneicu2006@gmail.com"];

interface AdminStats {
  campaigns: { total: number; active: number };
  leads: { total: number; avg_score: number; grades: Record<string, number> };
  pitches: { total: number; ready_to_call: number; ready_to_email: number; avg_score: number };
  outreach: { calls_total: number; calls_completed: number; emails_total: number; emails_sent: number };
  agents: { total: number };
  recent_campaigns: Array<Record<string, string>>;
  audit_log: Array<Record<string, string>>;
  cost_estimate: Record<string, unknown> | null;
}

export default function AdminDashboard() {
  const [authorized, setAuthorized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState("");

  // Auth check
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user?.email && ADMIN_EMAILS.includes(session.user.email)) {
        setAuthorized(true);
      }
      setLoading(false);
    });
  }, []);

  // Fetch stats
  const fetchStats = useCallback(async () => {
    try {
      const resp = await fetch(`${API}/api/admin/stats`);
      if (!resp.ok) throw new Error("Failed to load");
      const data = await resp.json();
      setStats(data);
    } catch {
      setError("Could not load admin data");
    }
  }, []);

  useEffect(() => {
    if (authorized) {
      fetchStats();
      const interval = setInterval(fetchStats, 30000); // Refresh every 30s
      return () => clearInterval(interval);
    }
  }, [authorized, fetchStats]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <p className="text-zinc-500">Loading...</p>
      </div>
    );
  }

  if (!authorized) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white mb-2">Access Denied</h1>
          <p className="text-zinc-500">Admin access only.</p>
          <a href="/" className="text-emerald-400 text-sm mt-4 inline-block hover:underline">
            Back to dashboard
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white">GRAI Admin</h1>
            <p className="text-zinc-500 text-sm">System overview and metrics</p>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={fetchStats} className="text-xs text-zinc-400 hover:text-white px-3 py-1.5 border border-zinc-700 rounded hover:border-zinc-500 transition-colors">
              Refresh
            </button>
            <a href="/" className="text-xs text-zinc-500 hover:text-zinc-300">
              Back to app
            </a>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}

        {stats && (
          <>
            {/* Top Stats Grid */}
            <div className="grid grid-cols-6 gap-4 mb-8">
              <MetricCard label="Campaigns" value={stats.campaigns.total} sub={`${stats.campaigns.active} active`} />
              <MetricCard label="Leads Found" value={stats.leads.total} sub={`Avg score: ${stats.leads.avg_score}`} color="emerald" />
              <MetricCard label="Pitches" value={stats.pitches.total} sub={`Score: ${stats.pitches.avg_score}/10`} color="blue" />
              <MetricCard label="Ready to Call" value={stats.pitches.ready_to_call} sub={`of ${stats.pitches.total}`} color="amber" />
              <MetricCard label="Calls Made" value={stats.outreach.calls_total} sub={`${stats.outreach.calls_completed} completed`} color="purple" />
              <MetricCard label="Emails Sent" value={stats.outreach.emails_sent} sub={`of ${stats.outreach.emails_total} total`} color="cyan" />
            </div>

            {/* Two Column Layout */}
            <div className="grid grid-cols-2 gap-6 mb-8">
              {/* Lead Grade Distribution */}
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
                <h3 className="text-white font-medium mb-4">Lead Grade Distribution</h3>
                <div className="space-y-3">
                  {["A", "B", "C", "D"].map((grade) => {
                    const count = stats.leads.grades[grade] || 0;
                    const pct = stats.leads.total > 0 ? (count / stats.leads.total) * 100 : 0;
                    const colors: Record<string, string> = {
                      A: "bg-emerald-500",
                      B: "bg-blue-500",
                      C: "bg-amber-500",
                      D: "bg-zinc-600",
                    };
                    return (
                      <div key={grade} className="flex items-center gap-3">
                        <span className="text-sm text-zinc-400 w-16">Grade {grade}</span>
                        <div className="flex-1 h-3 bg-zinc-800 rounded-full overflow-hidden">
                          <div className={`h-full ${colors[grade]} rounded-full`} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-sm text-zinc-500 w-12 text-right">{count}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Cost Estimate */}
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
                <h3 className="text-white font-medium mb-4">Cost Estimate (Last Run)</h3>
                {stats.cost_estimate ? (
                  <div className="space-y-2">
                    <CostRow label="LLM tokens (in)" value={String(stats.cost_estimate.total_tokens_in || 0)} />
                    <CostRow label="LLM tokens (out)" value={String(stats.cost_estimate.total_tokens_out || 0)} />
                    <CostRow label="API calls" value={String(stats.cost_estimate.total_api_calls || 0)} />
                    <CostRow label="Duration" value={`${stats.cost_estimate.duration_seconds || 0}s`} />
                    <div className="border-t border-zinc-800 pt-2 mt-2">
                      <CostRow label="Est. LLM cost" value={`$${stats.cost_estimate.estimated_llm_cost_usd || 0}`} highlight />
                      <CostRow label="Est. API cost" value={`$${stats.cost_estimate.estimated_api_cost_usd || 0}`} highlight />
                      <CostRow label="Est. total" value={`$${stats.cost_estimate.estimated_total_cost_usd || 0}`} highlight />
                    </div>
                  </div>
                ) : (
                  <p className="text-zinc-600 text-sm">No pipeline run tracked yet. Run an analysis to see costs.</p>
                )}
              </div>
            </div>

            {/* Agents & Outreach */}
            <div className="grid grid-cols-3 gap-4 mb-8">
              <SmallMetric label="Voice Agents" value={stats.agents.total} icon="🎙️" />
              <SmallMetric label="Ready to Email" value={stats.pitches.ready_to_email} icon="✉️" />
              <SmallMetric label="Calls Completed" value={stats.outreach.calls_completed} icon="📞" />
            </div>

            {/* Recent Campaigns */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 mb-8">
              <h3 className="text-white font-medium mb-4">Recent Campaigns</h3>
              {stats.recent_campaigns.length === 0 ? (
                <p className="text-zinc-600 text-sm">No campaigns yet.</p>
              ) : (
                <div className="space-y-2">
                  {stats.recent_campaigns.map((c, i) => (
                    <div key={i} className="flex items-center gap-4 p-3 bg-zinc-800/30 rounded-lg">
                      <span className={`w-2 h-2 rounded-full ${c.status === "active" ? "bg-emerald-400" : "bg-zinc-600"}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-sm font-medium truncate">{c.business_name || c.website_url}</p>
                        <p className="text-zinc-600 text-xs">{c.website_url}</p>
                      </div>
                      <span className="text-xs text-zinc-500">{c.created_at?.slice(0, 16)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* GDPR Audit Log */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
              <h3 className="text-white font-medium mb-4">GDPR Audit Log</h3>
              {stats.audit_log.length === 0 ? (
                <p className="text-zinc-600 text-sm">No audit entries yet. Data operations will be logged here.</p>
              ) : (
                <div className="space-y-1">
                  {stats.audit_log.map((entry, i) => (
                    <div key={i} className="flex items-center gap-3 text-xs py-1.5 px-3 bg-zinc-800/20 rounded">
                      <span className="text-zinc-600 w-32">{entry.created_at?.slice(0, 16)}</span>
                      <span className="text-zinc-400">{entry.action}</span>
                      <span className="text-zinc-600">{entry.entity_type} #{entry.entity_id}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* External Links */}
            <div className="mt-8 flex items-center gap-4 text-xs text-zinc-600">
              <a href="https://app.orq.ai" target="_blank" rel="noopener noreferrer" className="hover:text-zinc-400 transition-colors">
                Orq.ai Dashboard ↗
              </a>
              <a href="https://eu.posthog.com" target="_blank" rel="noopener noreferrer" className="hover:text-zinc-400 transition-colors">
                PostHog Analytics ↗
              </a>
              <a href="https://cgicbhfgqnkpvyzishru.supabase.co" target="_blank" rel="noopener noreferrer" className="hover:text-zinc-400 transition-colors">
                Supabase Dashboard ↗
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MetricCard({ label, value, sub, color = "zinc" }: { label: string; value: number; sub: string; color?: string }) {
  const borderColors: Record<string, string> = {
    zinc: "border-zinc-800",
    emerald: "border-emerald-500/30",
    blue: "border-blue-500/30",
    amber: "border-amber-500/30",
    purple: "border-purple-500/30",
    cyan: "border-cyan-500/30",
  };
  const textColors: Record<string, string> = {
    zinc: "text-white",
    emerald: "text-emerald-400",
    blue: "text-blue-400",
    amber: "text-amber-400",
    purple: "text-purple-400",
    cyan: "text-cyan-400",
  };
  return (
    <div className={`bg-zinc-900/60 border ${borderColors[color]} rounded-xl p-4`}>
      <p className="text-xs text-zinc-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${textColors[color]}`}>{value}</p>
      <p className="text-xs text-zinc-600 mt-0.5">{sub}</p>
    </div>
  );
}

function SmallMetric({ label, value, icon }: { label: string; value: number; icon: string }) {
  return (
    <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-4 flex items-center gap-3">
      <span className="text-2xl">{icon}</span>
      <div>
        <p className="text-xl font-bold text-white">{value}</p>
        <p className="text-xs text-zinc-500">{label}</p>
      </div>
    </div>
  );
}

function CostRow({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={`text-sm ${highlight ? "text-zinc-300 font-medium" : "text-zinc-500"}`}>{label}</span>
      <span className={`text-sm font-mono ${highlight ? "text-emerald-400" : "text-zinc-400"}`}>{value}</span>
    </div>
  );
}
