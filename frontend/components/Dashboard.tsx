"use client";

import { useState, useCallback, useEffect } from "react";
import { analytics } from "@/lib/analytics";
import LeadTable from "./LeadTable";
import ActivityFeed from "./ActivityFeed";
import OutreachPanel from "./OutreachPanel";
import ResultsDashboard from "./ResultsDashboard";

export type AgentEvent = {
  type: "text" | "tool_call" | "tool_result" | "agent_transfer";
  author: string;
  timestamp: string;
  content?: string;
  is_partial?: boolean;
  tool_name?: string;
  tool_args?: Record<string, unknown>;
  tool_result?: unknown;
  target_agent?: string;
};

type Tab = "activity" | "leads" | "outreach" | "results" | "logs";

const API = process.env.NEXT_PUBLIC_API_URL || "";

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`leadcall_${key}`);
    if (raw) return JSON.parse(raw) as T;
  } catch {}
  return fallback;
}

export default function Dashboard({ onLogout, campaignId, onBack }: { onLogout: () => void; campaignId?: number; onBack?: () => void }) {
  const [tab, setTab] = useState<Tab>("activity");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [pipelineState, setPipelineState] = useState<Record<string, unknown> | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [pipelineComplete, setPipelineComplete] = useState(false);
  const [chatInput, setChatInput] = useState("");

  // Restore state on mount
  useEffect(() => {
    const savedSession = loadFromStorage<string | null>("sessionId", null);
    if (savedSession) setSessionId(savedSession);

    // Use campaign-scoped state if we have a campaignId
    const stateUrl = campaignId
      ? `${API}/api/campaigns/${campaignId}/state`
      : `${API}/api/state`;

    fetch(stateUrl)
      .then((r) => r.json())
      .then((state) => {
        if (state && (state.business_analysis || state.leads?.length)) {
          setPipelineState(state);
          if (state.judged_pitches?.length > 0) setPipelineComplete(true);
        }
      })
      .catch(() => {});

    // If we have a URL from onboarding but no analysis yet, auto-start
    const savedUrl = loadFromStorage<string>("url", "");
    if (savedUrl && !savedSession && !campaignId) {
      startAnalysis(savedUrl);
    }
  }, [campaignId]);

  // Poll state every 5s while running
  useEffect(() => {
    if (!running) return;
    const stateUrl = campaignId
      ? `${API}/api/campaigns/${campaignId}/state`
      : `${API}/api/state`;
    const interval = setInterval(() => {
      fetch(stateUrl)
        .then((r) => r.json())
        .then((state) => setPipelineState(state))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [running, campaignId]);

  // SSE stream reader
  const readStream = useCallback(async (response: Response) => {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    if (!reader) return;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let gotComplete = false;

      for (const line of lines) {
        if (line.startsWith("data:")) {
          const dataStr = line.slice(5).trim();
          if (!dataStr) continue;
          try {
            const data = JSON.parse(dataStr);
            if (data.session_id) {
              setSessionId(data.session_id);
              try { localStorage.setItem("leadcall_sessionId", JSON.stringify(data.session_id)); } catch {}
              continue;
            }
            const event = data as AgentEvent;
            if (event.author && event.author !== "system") setActiveAgent(event.author);
            setEvents((prev) => [...prev, event]);

            if (event.type === "tool_result") {
              const su = campaignId ? `${API}/api/campaigns/${campaignId}/state` : `${API}/api/state`;
              fetch(su)
                .then((r) => r.json())
                .then((state) => setPipelineState(state))
                .catch(() => {});
            }
          } catch {}
        } else if (line.startsWith("event:")) {
          if (line.slice(6).trim() === "pipeline_complete") gotComplete = true;
        }
      }

      if (gotComplete) {
        setPipelineComplete(true);
        const su = campaignId ? `${API}/api/campaigns/${campaignId}/state` : `${API}/api/state`;
        fetch(su)
          .then((r) => r.json())
          .then((state) => setPipelineState(state))
          .catch(() => {});
      }
    }
  }, []);

  const startAnalysis = useCallback(async (urlOverride?: string) => {
    const targetUrl = urlOverride || loadFromStorage<string>("url", "");
    if (!targetUrl.trim() || running) return;
    analytics.analysisStarted(targetUrl);
    setRunning(true);
    setEvents([]);
    setActiveAgent(null);
    setPipelineComplete(false);

    try {
      const response = await fetch(`${API}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: targetUrl.trim() }),
      });
      await readStream(response);
    } catch (err) {
      console.error("Stream error:", err);
    } finally {
      setRunning(false);
      setActiveAgent(null);
    }
  }, [running, readStream]);

  const sendChat = useCallback(async () => {
    if (!chatInput.trim() || running) return;
    setRunning(true);
    const message = chatInput;
    setChatInput("");

    setEvents((prev) => [...prev, {
      type: "text", author: "you", timestamp: new Date().toISOString(), content: message,
    }]);

    try {
      const response = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, session_id: sessionId }),
      });
      await readStream(response);
    } catch (err) {
      console.error("Chat error:", err);
    } finally {
      setRunning(false);
      setActiveAgent(null);
    }
  }, [chatInput, running, sessionId, readStream]);

  // Extract data from pipeline state
  const businessName = (pipelineState?.business_analysis as Record<string, string>)?.business_name || "Your Business";
  const leads = (pipelineState?.scored_leads || pipelineState?.leads || []) as Record<string, unknown>[];
  const agents = (pipelineState?.elevenlabs_agents || []) as Record<string, unknown>[];
  const calls = (pipelineState?.call_results || []) as Record<string, unknown>[];

  // Merge pitches + judged_pitches: judged has scores, pitches has the actual text
  const pitches = (() => {
    const raw = (pipelineState?.pitches || []) as Record<string, unknown>[];
    const judged = (pipelineState?.judged_pitches || []) as Record<string, unknown>[];
    if (judged.length === 0) return raw;
    if (raw.length === 0) return judged;
    // Build lookup from raw pitches by lead_name
    const textByLead: Record<string, Record<string, unknown>> = {};
    for (const p of raw) {
      const name = String(p.lead_name || "");
      if (name) textByLead[name] = p;
    }
    // Merge: take judged data (scores) + fill in text from raw pitches
    return judged.map((j) => {
      const name = String(j.lead_name || "");
      const rawPitch = textByLead[name] || {};
      return {
        ...rawPitch,  // pitch_script, email_subject, email_body, etc.
        ...j,         // score, feedback, ready_to_call, ready_to_email, etc.
        // Ensure pitch text is available (judged might not have it)
        pitch_script: j.pitch_script || j.revised_pitch || rawPitch.pitch_script || "",
        email_subject: j.email_subject || rawPitch.email_subject || "",
        email_body: j.email_body || rawPitch.email_body || "",
      };
    });
  })();

  const stats = {
    leads: leads.length,
    gradeA: leads.filter((l) => l.score_grade === "A").length,
    gradeB: leads.filter((l) => l.score_grade === "B").length,
    readyToCall: pitches.filter((p) => p.ready_to_call).length,
    readyToEmail: pitches.filter((p) => p.ready_to_email).length,
    agentsCreated: agents.length,
    callsMade: calls.length,
  };

  const TABS: { id: Tab; label: string; badge?: number }[] = [
    { id: "activity", label: "Activity" },
    { id: "leads", label: "Leads", badge: stats.leads || undefined },
    { id: "outreach", label: "Outreach", badge: stats.readyToCall || undefined },
    { id: "results", label: "Results", badge: stats.callsMade || undefined },
    { id: "logs", label: "Debug Logs" },
  ];

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0f]">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center gap-4 bg-[#0d0d14]">
        {onBack ? (
          <button onClick={onBack} className="text-zinc-500 hover:text-zinc-300 mr-1" title="Back to campaigns">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        ) : null}
        <h1 className="text-lg font-bold text-emerald-400 tracking-tight">GRAI</h1>
        <span className="text-xs text-zinc-500">{businessName}</span>

        {running && (
          <span className="flex items-center gap-2 text-xs ml-4">
            <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
            <span className="text-emerald-400 font-medium">
              {activeAgent ? activeAgent.replace(/_/g, " ") : "Starting..."}
            </span>
          </span>
        )}

        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => startAnalysis()}
            disabled={running}
            className="text-xs text-zinc-400 hover:text-white px-3 py-1.5 border border-zinc-700 rounded hover:border-zinc-500 transition-colors disabled:opacity-50"
          >
            Re-analyze
          </button>
          <button
            onClick={onLogout}
            className="text-xs text-zinc-500 hover:text-zinc-300 px-2 py-1"
          >
            Logout
          </button>
        </div>
      </header>

      {/* Stats Bar */}
      {stats.leads > 0 && (
        <div className="border-b border-zinc-800 px-6 py-3 bg-[#0d0d14] flex items-center gap-6">
          <Stat label="Leads Found" value={stats.leads} />
          <Stat label="Grade A" value={stats.gradeA} color="emerald" />
          <Stat label="Grade B" value={stats.gradeB} color="blue" />
          <Stat label="Ready to Call" value={stats.readyToCall} color="amber" />
          <Stat label="Agents Created" value={stats.agentsCreated} color="purple" />
          <Stat label="Calls Made" value={stats.callsMade} color="cyan" />
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-zinc-800 px-6 bg-[#0d0d14]">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id); analytics.tabSwitched(t.id); }}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? "border-emerald-500 text-emerald-400"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t.label}
              {t.badge ? (
                <span className="ml-1.5 bg-zinc-800 text-zinc-400 text-xs px-1.5 py-0.5 rounded-full">
                  {t.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === "activity" && (
          <ActivityFeed
            events={events}
            running={running}
            activeAgent={activeAgent}
            pipelineComplete={pipelineComplete}
            pipelineState={pipelineState}
            chatInput={chatInput}
            onChatInputChange={setChatInput}
            onSendChat={sendChat}
            sessionId={sessionId}
            onSwitchTab={(t) => setTab(t as Tab)}
          />
        )}

        {tab === "leads" && (
          <LeadTable
            leads={leads}
            pitches={pitches}
            pipelineState={pipelineState}
          />
        )}

        {tab === "outreach" && (
          <OutreachPanel
            pitches={pitches}
            agents={agents}
            pipelineState={pipelineState}
            sessionId={sessionId}
          />
        )}

        {tab === "results" && (
          <ResultsDashboard
            calls={calls}
            leads={leads}
            agents={agents}
          />
        )}

        {tab === "logs" && (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="max-w-4xl mx-auto">
              <p className="text-zinc-500 text-sm mb-4">Raw agent trace log (debug mode)</p>
              <div className="space-y-1">
                {events.map((e, i) => (
                  <div key={i} className="text-xs font-mono p-2 rounded bg-zinc-900/50 border border-zinc-800/50">
                    <span className="text-zinc-600">{e.author}</span>
                    <span className="text-zinc-700 mx-1">|</span>
                    <span className="text-zinc-500">{e.type}</span>
                    <span className="text-zinc-700 mx-1">|</span>
                    <span className="text-zinc-400">
                      {e.content?.slice(0, 200) || e.tool_name || e.target_agent || ""}
                    </span>
                  </div>
                ))}
                {events.length === 0 && (
                  <p className="text-zinc-600 text-sm">No events yet. Start an analysis to see logs.</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, color = "zinc" }: { label: string; value: number; color?: string }) {
  const colors: Record<string, string> = {
    zinc: "text-white",
    emerald: "text-emerald-400",
    blue: "text-blue-400",
    amber: "text-amber-400",
    purple: "text-purple-400",
    cyan: "text-cyan-400",
  };
  return (
    <div className="flex items-center gap-2">
      <span className={`text-lg font-bold ${colors[color] || colors.zinc}`}>{value}</span>
      <span className="text-xs text-zinc-500">{label}</span>
    </div>
  );
}
