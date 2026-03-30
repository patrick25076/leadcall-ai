"use client";

import { useRef, useEffect } from "react";
import type { AgentEvent } from "./Dashboard";

const AGENT_ICONS: Record<string, string> = {
  website_analyzer: "🌐",
  lead_finder: "🔍",
  lead_scorer: "📊",
  pitch_generator: "✍️",
  pitch_judge: "⚖️",
  voice_config_agent: "🎙️",
  call_manager: "📞",
  leadcall_orchestrator: "🤖",
  system: "⚙️",
  you: "💬",
};

const FRIENDLY_NAMES: Record<string, string> = {
  website_analyzer: "Analyzing website",
  lead_finder: "Finding leads",
  lead_scorer: "Scoring leads",
  pitch_generator: "Writing pitches & emails",
  pitch_judge: "Reviewing quality",
  voice_config_agent: "Voice agent setup",
  call_manager: "Managing calls",
  leadcall_orchestrator: "AI Assistant",
};

interface ActivityFeedProps {
  events: AgentEvent[];
  running: boolean;
  activeAgent: string | null;
  pipelineComplete: boolean;
  pipelineState: Record<string, unknown> | null;
  chatInput: string;
  onChatInputChange: (v: string) => void;
  onSendChat: () => void;
  sessionId: string | null;
  onSwitchTab?: (tab: string) => void;
}

export default function ActivityFeed({
  events,
  running,
  activeAgent,
  pipelineComplete,
  pipelineState,
  chatInput,
  onChatInputChange,
  onSendChat,
  sessionId,
  onSwitchTab,
}: ActivityFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  // Filter events to show only user-friendly ones (text messages, not tool calls)
  const visibleEvents = events.filter((e) => {
    if (e.type === "text" && e.content) return true;
    if (e.type === "agent_transfer") return true;
    // Show tool results that are meaningful
    if (e.type === "tool_result" && e.tool_name) {
      const important = ["save_business_analysis", "save_leads", "score_leads", "save_pitch", "save_judged_pitches"];
      return important.includes(e.tool_name);
    }
    return false;
  });

  // Extract milestone summaries
  const analysis = pipelineState?.business_analysis as Record<string, unknown> | null;
  const leads = (pipelineState?.scored_leads || pipelineState?.leads || []) as Record<string, unknown>[];
  const pitches = (pipelineState?.judged_pitches || pipelineState?.pitches || []) as Record<string, unknown>[];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto space-y-4">

          {/* Running but no events yet */}
          {events.length === 0 && running && (
            <div className="text-center py-12">
              <div className="w-10 h-10 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin mx-auto mb-4" />
              <p className="text-zinc-300 text-lg mb-2">Analyzing your website...</p>
              <p className="text-zinc-600 text-sm">Crawling pages, detecting business model, finding leads. This takes 1-2 minutes.</p>
            </div>
          )}

          {/* Idle / waiting */}
          {events.length === 0 && !running && !pipelineComplete && !analysis && (
            <div className="text-center py-12">
              <p className="text-zinc-400 text-lg mb-2">Ready to analyze</p>
              <p className="text-zinc-600 text-sm">Click "Re-analyze" or enter a URL to start.</p>
            </div>
          )}

          {/* Milestone Cards */}
          {analysis && (
            <MilestoneCard
              icon="🌐"
              title={`Analyzed: ${(analysis.business_name as string) || "Your Business"}`}
              details={[
                `Industry: ${analysis.industry || "Detected"}`,
                `Location: ${analysis.city || ""}, ${analysis.country || ""}`,
                `Language: ${analysis.language || "Detected"}`,
                analysis.pricing_info ? `Pricing: ${(analysis.pricing_info as string).slice(0, 60)}...` : null,
              ].filter(Boolean) as string[]}
            />
          )}

          {leads.length > 0 && (
            <MilestoneCard
              icon="🔍"
              title={`Found ${leads.length} leads`}
              details={[
                `Grade A: ${leads.filter((l) => l.score_grade === "A").length}`,
                `Grade B: ${leads.filter((l) => l.score_grade === "B").length}`,
                `With phone: ${leads.filter((l) => l.phone).length}`,
                `With email: ${leads.filter((l) => l.email).length}`,
              ]}
              action={{ label: "View Leads →", onClick: () => {} }}
            />
          )}

          {pitches.length > 0 && (
            <MilestoneCard
              icon="✍️"
              title={`Created ${pitches.length} personalized pitches`}
              details={[
                `Ready to call: ${pitches.filter((p) => p.ready_to_call).length}`,
                `Ready to email: ${pitches.filter((p) => p.ready_to_email).length}`,
                `Avg score: ${(pitches.reduce((sum, p) => sum + ((p.score as number) || 0), 0) / pitches.length).toFixed(1)}/10`,
              ]}
            />
          )}

          {/* Live Agent Messages */}
          {visibleEvents.map((e, i) => {
            if (e.type === "agent_transfer") {
              return (
                <div key={i} className="flex items-center gap-2 text-xs text-zinc-600 py-1">
                  <div className="flex-1 h-px bg-zinc-800" />
                  <span>{FRIENDLY_NAMES[e.target_agent || ""] || e.target_agent}</span>
                  <div className="flex-1 h-px bg-zinc-800" />
                </div>
              );
            }

            if (e.type === "tool_result" && e.tool_name) {
              return (
                <ToolResultCard key={i} toolName={e.tool_name} result={e.tool_result} />
              );
            }

            if (e.author === "you") {
              return (
                <div key={i} className="flex justify-end">
                  <div className="bg-emerald-600/20 border border-emerald-500/20 rounded-xl rounded-br-sm px-4 py-2.5 max-w-md">
                    <p className="text-emerald-100 text-sm">{e.content}</p>
                  </div>
                </div>
              );
            }

            // Agent text message
            return (
              <div key={i} className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-sm flex-shrink-0">
                  {AGENT_ICONS[e.author] || "🤖"}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-zinc-500 mb-1">
                    {FRIENDLY_NAMES[e.author] || e.author?.replace(/_/g, " ") || "AI"}
                  </p>
                  <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl rounded-tl-sm px-4 py-2.5">
                    <p className="text-zinc-300 text-sm whitespace-pre-wrap leading-relaxed">
                      {e.content}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}

          {/* Typing indicator */}
          {running && activeAgent && (
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-sm">
                {AGENT_ICONS[activeAgent] || "🤖"}
              </div>
              <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl rounded-tl-sm px-4 py-3">
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            </div>
          )}

          {/* Pipeline complete — Next Steps */}
          {pipelineComplete && !running && (
            <div className="space-y-3">
              <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
                <p className="text-emerald-400 font-medium mb-3">Your campaign is ready! Here's what to do next:</p>
                <div className="space-y-2">
                  <NextStepButton
                    step="1"
                    label="Review your leads"
                    description={`${leads.length} leads found — approve the ones you want to contact`}
                    onClick={() => onSwitchTab?.("leads")}
                  />
                  <NextStepButton
                    step="2"
                    label="Test the AI call agent"
                    description="Call your own phone to hear exactly what leads will hear"
                    onClick={() => onSwitchTab?.("outreach")}
                  />
                  <NextStepButton
                    step="3"
                    label="Preview email drafts"
                    description="Send a test email to yourself before reaching out"
                    onClick={() => onSwitchTab?.("outreach")}
                  />
                  <NextStepButton
                    step="4"
                    label="Approve & launch outreach"
                    description="Review each call and email, then approve to start"
                    onClick={() => onSwitchTab?.("outreach")}
                  />
                </div>
              </div>

              <div className="p-3 bg-zinc-800/30 rounded-lg">
                <p className="text-zinc-500 text-xs text-center">
                  Or ask the AI anything below — "change the pitch for [lead name]", "make the tone more friendly", "set up voice agents"
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Chat Input */}
      <div className="border-t border-zinc-800 bg-[#0d0d14] p-4">
        <div className="max-w-2xl mx-auto flex gap-2">
          <input
            type="text"
            value={chatInput}
            onChange={(e) => onChatInputChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSendChat()}
            placeholder={
              sessionId
                ? "Ask anything... (e.g. 'change the pitch for Hotel Maraton', 'set up voice agents')"
                : "Waiting for analysis to complete..."
            }
            disabled={!sessionId}
            className="flex-1 bg-zinc-800/50 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm
              placeholder-zinc-600 focus:outline-none focus:border-emerald-500
              disabled:opacity-40"
          />
          <button
            onClick={onSendChat}
            disabled={running || !chatInput.trim() || !sessionId}
            className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600
              rounded-xl text-sm font-medium transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function MilestoneCard({
  icon,
  title,
  details,
  action,
}: {
  icon: string;
  title: string;
  details: string[];
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-start gap-3">
        <span className="text-xl">{icon}</span>
        <div className="flex-1">
          <p className="text-white font-medium text-sm">{title}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
            {details.map((d, i) => (
              <span key={i} className="text-xs text-zinc-400">{d}</span>
            ))}
          </div>
        </div>
        {action && (
          <button
            onClick={action.onClick}
            className="text-xs text-emerald-400 hover:text-emerald-300 whitespace-nowrap"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

function ToolResultCard({ toolName, result }: { toolName: string; result: unknown }) {
  const labels: Record<string, string> = {
    save_business_analysis: "Business analysis saved",
    save_leads: "Leads discovered",
    score_leads: "Leads scored",
    save_pitch: "Pitches generated",
    save_judged_pitches: "Pitches reviewed",
  };

  const r = result as Record<string, unknown> | null;
  const count = r?.count || r?.total_leads || r?.total || "";

  return (
    <div className="flex items-center gap-2 text-xs py-1 px-3 bg-zinc-800/30 rounded-lg">
      <span className="text-emerald-500">&#10003;</span>
      <span className="text-zinc-400">{labels[toolName] || toolName}</span>
      {count && <span className="text-zinc-500">({String(count)})</span>}
    </div>
  );
}

function NextStepButton({
  step,
  label,
  description,
  onClick,
}: {
  step: string;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 p-3 bg-zinc-800/40 hover:bg-zinc-800/70 border border-zinc-700/50 rounded-lg text-left transition-colors group"
    >
      <span className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-xs font-bold flex-shrink-0">
        {step}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm font-medium group-hover:text-emerald-400 transition-colors">{label}</p>
        <p className="text-zinc-500 text-xs">{description}</p>
      </div>
      <span className="text-zinc-600 group-hover:text-zinc-400 transition-colors text-sm">&#8250;</span>
    </button>
  );
}
