"use client";

import { useState, useEffect } from "react";

type PipelineState = {
  business_analysis: Record<string, unknown> | null;
  leads: Array<Record<string, unknown>>;
  scored_leads: Array<Record<string, unknown>>;
  pitches: Array<Record<string, unknown>>;
  judged_pitches: Array<Record<string, unknown>>;
  preferences: Record<string, unknown>;
  elevenlabs_agents: Array<Record<string, unknown>>;
  call_results: Array<Record<string, unknown>>;
};

export function StatePanel({
  pipelineState,
}: {
  pipelineState: Record<string, unknown> | null;
}) {
  const [state, setState] = useState<PipelineState | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    business: true,
    leads: true,
    pitches: false,
    judged: true,
    preferences: false,
    agents: true,
    calls: true,
  });

  // Poll for state updates
  useEffect(() => {
    if (pipelineState) {
      setState(pipelineState as unknown as PipelineState);
      return;
    }

    const interval = setInterval(async () => {
      try {
        const resp = await fetch("/api/state");
        if (resp.ok) {
          const data = await resp.json();
          setState(data);
        }
      } catch {}
    }, 3000);

    return () => clearInterval(interval);
  }, [pipelineState]);

  const toggle = (key: string) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="p-4">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
        Pipeline State
      </h2>

      {!state ? (
        <p className="text-xs text-gray-600 italic">Waiting for data...</p>
      ) : (
        <div className="space-y-3">
          {/* Business Analysis */}
          <Section
            title="Business Analysis"
            badge={state.business_analysis ? "1" : "0"}
            badgeColor={state.business_analysis ? "emerald" : "gray"}
            expanded={expanded.business}
            onToggle={() => toggle("business")}
          >
            {state.business_analysis ? (
              <BusinessCard data={state.business_analysis} />
            ) : (
              <p className="text-xs text-gray-600 italic">Not analyzed yet</p>
            )}
          </Section>

          {/* Scored Leads */}
          <Section
            title="Leads"
            badge={String(state.scored_leads?.length || state.leads?.length || 0)}
            badgeColor={(state.scored_leads?.length || state.leads?.length) ? "orange" : "gray"}
            expanded={expanded.leads}
            onToggle={() => toggle("leads")}
          >
            {(state.scored_leads?.length || state.leads?.length) ? (
              <div className="space-y-2">
                {(state.scored_leads?.length ? state.scored_leads : state.leads).map((lead, i) => {
                  const grade = lead.score_grade as string;
                  const gradeColor = grade === "A" ? "text-emerald-400" : grade === "B" ? "text-blue-400" : grade === "C" ? "text-yellow-400" : "text-red-400";
                  return (
                    <div
                      key={i}
                      className="bg-[#0a0a10] rounded p-2.5 border border-gray-800"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-orange-400">
                          {String(lead.name || `Lead ${i + 1}`)}
                        </span>
                        {grade ? (
                          <span className={`text-xs font-bold ${gradeColor}`}>
                            {grade} ({String(lead.lead_score)}/100)
                          </span>
                        ) : null}
                      </div>
                      {lead.contact_person ? (
                        <div className="text-[10px] text-cyan-400 mt-0.5">
                          Contact: {String(lead.contact_person)}
                        </div>
                      ) : null}
                      {lead.website ? (
                        <div className="text-[10px] text-gray-500 truncate mt-0.5">
                          {String(lead.website)}
                        </div>
                      ) : null}
                      <div className="flex items-center gap-2 mt-1">
                        {lead.phone ? (
                          <span className="text-[9px] px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400/80 rounded">
                            {String(lead.phone)}
                          </span>
                        ) : (
                          <span className="text-[9px] px-1.5 py-0.5 bg-red-500/10 text-red-400/80 rounded">
                            No phone
                          </span>
                        )}
                        {lead.source ? (
                          <span className="text-[9px] px-1.5 py-0.5 bg-gray-700/30 text-gray-500 rounded">
                            {String(lead.source)}
                          </span>
                        ) : null}
                      </div>
                      {lead.address ? (
                        <div className="text-[10px] text-gray-600 mt-1">
                          {String(lead.address)}
                        </div>
                      ) : null}
                      {lead.relevance_reason ? (
                        <div className="text-[10px] text-gray-500 mt-1 italic">
                          {String(lead.relevance_reason)}
                        </div>
                      ) : null}
                      {lead.score_breakdown ? (
                        <ScoreBreakdown breakdown={lead.score_breakdown as Record<string, string>} />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-gray-600 italic">No leads yet</p>
            )}
          </Section>

          {/* Judged Pitches */}
          <Section
            title="Pitch Results"
            badge={String(state.judged_pitches?.length || 0)}
            badgeColor={state.judged_pitches?.length ? "yellow" : "gray"}
            expanded={expanded.judged}
            onToggle={() => toggle("judged")}
          >
            {state.judged_pitches?.length ? (
              <div className="space-y-2">
                {state.judged_pitches.map((jp, i) => (
                  <div
                    key={i}
                    className="bg-[#0a0a10] rounded p-2.5 border border-gray-800"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-yellow-400">
                        {(jp.lead_name as string) || `Pitch ${i + 1}`}
                      </span>
                      <span
                        className={`text-xs font-bold ${
                          (jp.score as number) >= 7
                            ? "text-emerald-400"
                            : "text-red-400"
                        }`}
                      >
                        {jp.score as number}/10
                      </span>
                    </div>
                    {jp.contact_person ? (
                      <div className="text-[10px] text-cyan-400 mt-0.5">
                        To: {String(jp.contact_person)}
                      </div>
                    ) : null}
                    {jp.phone_number ? (
                      <div className="text-[10px] text-gray-400 mt-0.5">
                        Tel: {String(jp.phone_number)}
                      </div>
                    ) : null}
                    <div className="text-[10px] text-gray-500 mt-1">
                      {jp.feedback as string}
                    </div>
                    <div className="mt-1.5 flex gap-2">
                      {jp.ready_to_call ? (
                        <span className="text-[10px] px-1.5 py-0.5 bg-emerald-500/20 text-emerald-400 rounded">
                          Ready to call
                        </span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded">
                          Needs work
                        </span>
                      )}
                    </div>
                    {jp.missing_info && Array.isArray(jp.missing_info) && (jp.missing_info as string[]).length > 0 ? (
                      <div className="mt-1 text-[9px] text-red-400/60">
                        Missing: {(jp.missing_info as string[]).join(", ")}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-600 italic">No pitch results yet</p>
            )}
          </Section>

          {/* ElevenLabs Agents */}
          {state.elevenlabs_agents?.length > 0 && (
            <Section
              title="Voice Agents"
              badge={String(state.elevenlabs_agents.length)}
              badgeColor="purple"
              expanded={expanded.agents}
              onToggle={() => toggle("agents")}
            >
              <div className="space-y-2">
                {state.elevenlabs_agents.map((agent, i) => (
                  <div
                    key={i}
                    className="bg-[#0a0a10] rounded p-2.5 border border-purple-500/10"
                  >
                    <div className="text-[11px] text-purple-400 font-medium">
                      {agent.name as string}
                    </div>
                    <div className="text-[9px] text-gray-600 mt-0.5 font-mono">
                      ID: {agent.agent_id as string}
                    </div>
                    {agent.dynamic_variables ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {Object.entries(agent.dynamic_variables as Record<string, string>)
                          .filter(([, v]) => v && v.length > 0)
                          .slice(0, 4)
                          .map(([k, v]) => (
                            <span key={k} className="text-[8px] px-1 py-0.5 bg-purple-500/10 text-purple-300/70 rounded">
                              {`{{${k}}}`}: {String(v).slice(0, 20)}
                            </span>
                          ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Call Results */}
          {state.call_results?.length > 0 && (
            <Section
              title="Calls"
              badge={String(state.call_results.length)}
              badgeColor="red"
              expanded={expanded.calls}
              onToggle={() => toggle("calls")}
            >
              <div className="space-y-2">
                {state.call_results.map((call, i) => (
                  <div
                    key={i}
                    className="bg-[#0a0a10] rounded p-2.5 border border-red-500/10"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-red-400">
                        {String(call.phone_number)}
                      </span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded ${
                        call.status === "completed" ? "bg-emerald-500/15 text-emerald-400" :
                        call.status === "initiated" ? "bg-yellow-500/15 text-yellow-400" :
                        "bg-gray-500/15 text-gray-400"
                      }`}>
                        {String(call.status)}
                      </span>
                    </div>
                    <div className="text-[9px] text-gray-600 mt-0.5 font-mono">
                      {call.call_sid ? `SID: ${String(call.call_sid)}` : `Agent: ${String(call.agent_id)}`}
                    </div>
                    {call.duration ? (
                      <div className="text-[9px] text-gray-500 mt-0.5">
                        Duration: {String(call.duration)}s
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Preferences */}
          <Section
            title="Preferences"
            badge=""
            badgeColor="gray"
            expanded={expanded.preferences}
            onToggle={() => toggle("preferences")}
          >
            <JsonBlock data={state.preferences} />
          </Section>
        </div>
      )}
    </div>
  );
}

/* ─── Business Analysis Card ──────────────────────────────────────────────── */

function BusinessCard({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="bg-[#0a0a10] rounded p-2.5 border border-cyan-500/10 space-y-1.5">
      <div className="text-xs text-cyan-400 font-medium">{String(data.business_name || "")}</div>
      <div className="text-[10px] text-gray-400">
        {String(data.industry || "")} — {String(data.city || "")}, {String(data.country || "")}
      </div>
      {data.website_url ? (
        <div className="text-[10px] text-gray-500 truncate">{String(data.website_url)}</div>
      ) : null}
      {data.services && Array.isArray(data.services) ? (
        <div>
          <div className="text-[9px] text-gray-600 uppercase mb-1">Services</div>
          <div className="flex flex-wrap gap-1">
            {(data.services as string[]).map((s, i) => (
              <span key={i} className="text-[9px] px-1.5 py-0.5 bg-cyan-500/10 text-cyan-400/70 rounded">
                {s}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {data.pricing_info && String(data.pricing_info) !== "Not found" ? (
        <div>
          <div className="text-[9px] text-gray-600 uppercase mb-0.5">Pricing</div>
          <div className="text-[10px] text-emerald-400/70">{String(data.pricing_info).slice(0, 200)}</div>
        </div>
      ) : null}
      {data.summary ? (
        <div className="text-[10px] text-gray-500 italic">{String(data.summary)}</div>
      ) : null}
      {data.language ? (
        <span className="text-[9px] px-1.5 py-0.5 bg-gray-700/30 text-gray-500 rounded">
          {String(data.language)}
        </span>
      ) : null}
    </div>
  );
}

/* ─── Score Breakdown ─────────────────────────────────────────────────────── */

function ScoreBreakdown({ breakdown }: { breakdown: Record<string, string> }) {
  return (
    <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5">
      {Object.entries(breakdown).map(([key, val]) => (
        <div key={key} className="text-[8px] text-gray-600">
          <span className="text-gray-500">{key}:</span> {val}
        </div>
      ))}
    </div>
  );
}

/* ─── Shared Components ───────────────────────────────────────────────────── */

function Section({
  title,
  badge,
  badgeColor,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  badge: string;
  badgeColor: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const colorMap: Record<string, string> = {
    emerald: "bg-emerald-500/20 text-emerald-400",
    orange: "bg-orange-500/20 text-orange-400",
    yellow: "bg-yellow-500/20 text-yellow-400",
    red: "bg-red-500/20 text-red-400",
    purple: "bg-purple-500/20 text-purple-400",
    gray: "bg-gray-700/20 text-gray-500",
  };

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-gray-800/30 transition-colors"
      >
        <span className="text-gray-500 text-[10px] w-3">{expanded ? "▾" : "▸"}</span>
        <span className="text-gray-300 font-medium">{title}</span>
        {badge && (
          <span
            className={`ml-auto text-[10px] px-1.5 py-0.5 rounded ${colorMap[badgeColor]}`}
          >
            {badge}
          </span>
        )}
      </button>
      {expanded && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

function JsonBlock({ data }: { data: unknown }) {
  const str = JSON.stringify(data, null, 2);
  const truncated = str.length > 1000 ? str.slice(0, 1000) + "\n..." : str;
  return (
    <pre className="text-[10px] text-gray-500 bg-[#0a0a10] rounded p-2 overflow-x-auto max-h-60 overflow-y-auto">
      {truncated}
    </pre>
  );
}
