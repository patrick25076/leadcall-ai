"use client";

import { useState, useEffect, useCallback } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "";

type Campaign = {
  id: number;
  website_url: string;
  business_name: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  lead_count: number;
  pitch_count: number;
  agent_count: number;
};

type PipelineStage = "analyze" | "leads" | "pitches" | "voice" | "calling";

function getCampaignStage(c: Campaign): PipelineStage {
  if (c.agent_count > 0) return "calling";
  if (c.pitch_count > 0) return "voice";
  if (c.lead_count > 0) return "pitches";
  if (c.business_name) return "leads";
  return "analyze";
}

const STAGES: { key: PipelineStage; label: string }[] = [
  { key: "analyze", label: "Analyze" },
  { key: "leads", label: "Find Leads" },
  { key: "pitches", label: "Pitches" },
  { key: "voice", label: "Voice Setup" },
  { key: "calling", label: "Calling" },
];

export default function CampaignList({
  onSelectCampaign,
  onNewCampaign,
  onLogout,
}: {
  onSelectCampaign: (id: number) => void;
  onNewCampaign: () => void;
  onLogout: () => void;
}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchCampaigns = useCallback(async () => {
    try {
      const resp = await fetch(`${API}/api/campaigns`);
      if (resp.ok) {
        const data = await resp.json();
        setCampaigns(data.campaigns || []);
      }
    } catch {
      // Silently fail — campaigns will be empty
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCampaigns();
  }, [fetchCampaigns]);

  const statusColors: Record<string, string> = {
    active: "bg-emerald-500/20 text-emerald-400",
    completed: "bg-blue-500/20 text-blue-400",
    failed: "bg-red-500/20 text-red-400",
  };

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0f]">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-4 bg-[#0d0d14] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-emerald-400 tracking-tight">GRAI</h1>
          <span className="text-xs text-zinc-600 border-l border-zinc-700 pl-3">Campaigns</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onNewCampaign}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            + New Campaign
          </button>
          <button
            onClick={onLogout}
            className="text-xs text-zinc-500 hover:text-zinc-300 px-2 py-1"
          >
            Logout
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-6 py-8">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-zinc-500">Loading campaigns...</div>
          </div>
        ) : campaigns.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div className="w-16 h-16 rounded-full bg-zinc-800/50 flex items-center justify-center">
              <svg className="w-8 h-8 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-zinc-300">No campaigns yet</h2>
            <p className="text-sm text-zinc-500 text-center max-w-md">
              Create your first campaign by entering a business website URL. GRAI will analyze
              the business, find leads, and generate personalized outreach.
            </p>
            <button
              onClick={onNewCampaign}
              className="mt-2 px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition-colors"
            >
              Create First Campaign
            </button>
          </div>
        ) : (
          <div className="grid gap-4">
            {campaigns.map((c) => {
              const stage = getCampaignStage(c);
              const stageIdx = STAGES.findIndex((s) => s.key === stage);

              return (
                <div key={c.id} className="bg-[#0d0d14] border border-zinc-800 rounded-xl hover:border-zinc-600 transition-all group">
                  <button
                    onClick={() => onSelectCampaign(c.id)}
                    className="w-full text-left p-5"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-1">
                          <h3 className="text-base font-semibold text-zinc-200 group-hover:text-white truncate">
                            {c.business_name || "Analyzing..."}
                          </h3>
                          <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[c.status] || statusColors.active}`}>
                            {c.status}
                          </span>
                        </div>
                        <p className="text-sm text-zinc-500 truncate">{c.website_url}</p>

                        {/* Pipeline Progress */}
                        <div className="flex items-center gap-1 mt-3 mb-3">
                          {STAGES.map((s, i) => (
                            <div key={s.key} className="flex items-center gap-1">
                              <div className={`h-1.5 w-8 rounded-full ${
                                i <= stageIdx ? "bg-emerald-500" : "bg-zinc-800"
                              }`} />
                            </div>
                          ))}
                          <span className="text-xs text-zinc-500 ml-2">{STAGES[stageIdx].label}</span>
                        </div>

                        <div className="flex items-center gap-4">
                          <CampaignStat label="Leads" value={c.lead_count} />
                          <CampaignStat label="Pitches" value={c.pitch_count} />
                          <CampaignStat label="Agents" value={c.agent_count} />
                          <span className="text-xs text-zinc-600 ml-auto">{formatDate(c.created_at)}</span>
                        </div>
                      </div>
                      <svg
                        className="w-5 h-5 text-zinc-600 group-hover:text-zinc-400 mt-1 ml-4 flex-shrink-0"
                        fill="none" viewBox="0 0 24 24" stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                  </button>

                  {/* Quick Actions */}
                  <div className="border-t border-zinc-800/50 px-5 py-2 flex items-center gap-3">
                    <button
                      onClick={(e) => { e.stopPropagation(); onSelectCampaign(c.id); }}
                      className="text-xs text-zinc-500 hover:text-emerald-400 transition-colors"
                    >
                      Open
                    </button>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm("Delete this campaign and all its data? This cannot be undone.")) return;
                        try {
                          await fetch(`${API}/api/campaigns/${c.id}`, { method: "DELETE" });
                          fetchCampaigns();
                        } catch {}
                      }}
                      className="text-xs text-zinc-600 hover:text-red-400 transition-colors ml-auto"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function CampaignStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-sm font-medium text-zinc-300">{value}</span>
      <span className="text-xs text-zinc-600">{label}</span>
    </div>
  );
}
