"use client";

import type { PipelineStep } from "@/app/page";

const AGENT_LABELS: Record<string, { label: string; description: string; icon: string }> = {
  website_analyzer: {
    label: "Web Analyzer",
    description: "Crawls multiple pages (services, pricing, about)",
    icon: "🌐",
  },
  lead_finder: {
    label: "Lead Finder",
    description: "Google Maps + Brave Search, same city preferred",
    icon: "🔍",
  },
  lead_scorer: {
    label: "Lead Scorer",
    description: "Scores by location, industry, size, LTV",
    icon: "📊",
  },
  pitch_generator: {
    label: "Pitch Generator",
    description: "Personalized scripts with lead names",
    icon: "✍️",
  },
  pitch_judge: {
    label: "Pitch Judge",
    description: "Evaluates quality & call readiness",
    icon: "⚖️",
  },
};

const STATUS_STYLES: Record<string, { dot: string; ring: string; text: string; bg: string }> = {
  pending: { dot: "bg-gray-600", ring: "border-gray-700", text: "text-gray-500", bg: "border-gray-800 bg-[#0e0e16]" },
  active: { dot: "bg-emerald-400 animate-pulse", ring: "border-emerald-500", text: "text-emerald-400", bg: "border-emerald-500/30 bg-emerald-500/5" },
  done: { dot: "bg-emerald-500", ring: "border-emerald-600", text: "text-gray-300", bg: "border-emerald-600/20 bg-emerald-500/5" },
  error: { dot: "bg-red-500", ring: "border-red-600", text: "text-red-400", bg: "border-red-600/20 bg-red-500/5" },
};

export function PipelineView({ steps, pipelineState }: { steps: PipelineStep[]; pipelineState: Record<string, unknown> | null }) {
  return (
    <div className="p-4">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
        Pipeline
      </h2>

      {steps.length === 0 ? (
        <p className="text-xs text-gray-600 italic">
          Enter a URL to start the pipeline
        </p>
      ) : (
        <div className="space-y-1">
          {steps.map((step, i) => {
            const meta = AGENT_LABELS[step.agent] || {
              label: step.agent,
              description: "",
              icon: "⚙️",
            };
            const style = STATUS_STYLES[step.status];
            const toolCalls = step.events.filter((e) => e.type === "tool_call");

            return (
              <div key={step.agent}>
                {/* Connector line */}
                {i > 0 && (
                  <div className="ml-4 h-3 border-l border-gray-700" />
                )}

                <div className={`rounded-lg border ${style.bg} p-3`}>
                  {/* Header */}
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-2.5 h-2.5 rounded-full ${style.dot} ring-2 ${style.ring}`}
                    />
                    <span className="text-sm">{meta.icon}</span>
                    <span className={`text-sm font-medium ${style.text}`}>
                      {meta.label}
                    </span>
                    <span className="text-[10px] text-gray-600 ml-auto">
                      {step.status === "active"
                        ? "running..."
                        : step.status === "done"
                        ? "complete"
                        : step.status === "error"
                        ? "failed"
                        : ""}
                    </span>
                  </div>

                  <p className="text-[11px] text-gray-500 mt-1 ml-[26px]">
                    {meta.description}
                  </p>

                  {/* Tool calls (show while active) */}
                  {step.status === "active" && toolCalls.length > 0 && (
                    <div className="mt-2 ml-[26px] space-y-1">
                      {toolCalls.slice(-3).map((tc, j) => (
                        <div
                          key={j}
                          className="flex items-center gap-1.5 text-[11px]"
                        >
                          <span className="text-yellow-500/70">fn</span>
                          <span className="text-gray-400">{tc.tool_name}</span>
                          {tc.tool_args &&
                            Object.keys(tc.tool_args).length > 0 && (
                              <span className="text-gray-600 truncate max-w-[150px]">
                                ({Object.keys(tc.tool_args).join(", ")})
                              </span>
                            )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Rich output cards when step is done */}
                  {step.status === "done" && (
                    <StepOutput agent={step.agent} pipelineState={pipelineState} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Standalone Agents */}
      <div className="mt-6">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Standalone Agents
        </h2>
        <div className="space-y-2">
          {[
            { name: "Voice Config", desc: "Assesses readiness, gathers missing info, configures voice agents", icon: "🎙️" },
            { name: "Preferences", desc: "Pricing, calendar, call style, language settings", icon: "⚙️" },
            { name: "Call Manager", desc: "Creates ElevenLabs agents & initiates outbound calls", icon: "📞" },
          ].map((a) => (
            <div
              key={a.name}
              className="rounded-lg border border-gray-800 bg-[#0e0e16] p-3"
            >
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-blue-500/50 ring-2 ring-blue-600/30" />
                <span className="text-sm">{a.icon}</span>
                <span className="text-sm text-gray-400">{a.name}</span>
              </div>
              <p className="text-[11px] text-gray-600 mt-1 ml-[26px]">{a.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Rich per-step output summaries ──────────────────────────────────────── */

function StepOutput({ agent, pipelineState }: { agent: string; pipelineState: Record<string, unknown> | null }) {
  if (!pipelineState) return null;

  if (agent === "website_analyzer") {
    const analysis = pipelineState.business_analysis as Record<string, unknown> | null;
    if (!analysis) return null;
    return (
      <div className="mt-2 ml-[26px] bg-[#0a0a10] rounded-lg p-2.5 border border-cyan-500/10">
        <div className="text-[11px] text-cyan-400 font-medium">{String(analysis.business_name || "")}</div>
        <div className="text-[10px] text-gray-500 mt-1">{String(analysis.industry || "")} — {String(analysis.city || "")}, {String(analysis.country || "")}</div>
        {analysis.services && Array.isArray(analysis.services) ? (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {(analysis.services as string[]).slice(0, 4).map((s, i) => (
              <span key={i} className="text-[9px] px-1.5 py-0.5 bg-cyan-500/10 text-cyan-400/80 rounded">
                {s}
              </span>
            ))}
            {(analysis.services as string[]).length > 4 ? (
              <span className="text-[9px] text-gray-600">+{(analysis.services as string[]).length - 4} more</span>
            ) : null}
          </div>
        ) : null}
        {analysis.pricing_info && String(analysis.pricing_info) !== "Not found" ? (
          <div className="text-[10px] text-emerald-400/70 mt-1">
            Pricing found
          </div>
        ) : null}
      </div>
    );
  }

  if (agent === "lead_finder") {
    const leads = (pipelineState.leads || []) as Array<Record<string, unknown>>;
    if (leads.length === 0) return null;
    return (
      <div className="mt-2 ml-[26px] bg-[#0a0a10] rounded-lg p-2.5 border border-orange-500/10">
        <div className="text-[11px] text-orange-400 font-medium">{leads.length} leads discovered</div>
        <div className="mt-1.5 space-y-1">
          {leads.slice(0, 3).map((lead, i) => (
            <div key={i} className="flex items-center gap-2 text-[10px]">
              <span className="text-orange-300">{String(lead.name || `Lead ${i + 1}`)}</span>
              {lead.phone ? (
                <span className="text-emerald-500/70">has phone</span>
              ) : (
                <span className="text-red-500/50">no phone</span>
              )}
              {lead.source ? (
                <span className="text-gray-600">{String(lead.source)}</span>
              ) : null}
            </div>
          ))}
          {leads.length > 3 && (
            <div className="text-[9px] text-gray-600">+{leads.length - 3} more leads</div>
          )}
        </div>
      </div>
    );
  }

  if (agent === "lead_scorer") {
    const scored = (pipelineState.scored_leads || []) as Array<Record<string, unknown>>;
    if (scored.length === 0) return null;
    const grades = { A: 0, B: 0, C: 0, D: 0 };
    scored.forEach((s) => {
      const g = String(s.score_grade || "D") as keyof typeof grades;
      if (g in grades) grades[g]++;
    });
    return (
      <div className="mt-2 ml-[26px] bg-[#0a0a10] rounded-lg p-2.5 border border-blue-500/10">
        <div className="text-[11px] text-blue-400 font-medium">{scored.length} leads scored</div>
        <div className="flex gap-3 mt-1.5">
          {grades.A > 0 && <GradeBadge grade="A" count={grades.A} color="emerald" />}
          {grades.B > 0 && <GradeBadge grade="B" count={grades.B} color="blue" />}
          {grades.C > 0 && <GradeBadge grade="C" count={grades.C} color="yellow" />}
          {grades.D > 0 && <GradeBadge grade="D" count={grades.D} color="red" />}
        </div>
        <div className="mt-1.5 text-[10px] text-gray-500">
          Top: {String((scored[0] as Record<string, unknown>)?.name || "")} ({String((scored[0] as Record<string, unknown>)?.lead_score || 0)}/100)
        </div>
      </div>
    );
  }

  if (agent === "pitch_generator") {
    const pitches = (pipelineState.pitches || []) as Array<Record<string, unknown>>;
    if (pitches.length === 0) return null;
    return (
      <div className="mt-2 ml-[26px] bg-[#0a0a10] rounded-lg p-2.5 border border-green-500/10">
        <div className="text-[11px] text-green-400 font-medium">{pitches.length} pitches created</div>
        <div className="mt-1.5 space-y-1">
          {pitches.slice(0, 3).map((p, i) => (
            <div key={i} className="text-[10px]">
              <span className="text-green-300">{String(p.lead_name || p.contact_person || `Pitch ${i + 1}`)}</span>
              <span className="text-gray-600 ml-1.5">
                {String(p.pitch_script || "").slice(0, 60)}...
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (agent === "pitch_judge") {
    const judged = (pipelineState.judged_pitches || []) as Array<Record<string, unknown>>;
    if (judged.length === 0) return null;
    const ready = judged.filter((j) => j.ready_to_call).length;
    return (
      <div className="mt-2 ml-[26px] bg-[#0a0a10] rounded-lg p-2.5 border border-yellow-500/10">
        <div className="text-[11px] text-yellow-400 font-medium">{judged.length} pitches judged</div>
        <div className="flex items-center gap-3 mt-1.5">
          <span className="text-[10px] px-1.5 py-0.5 bg-emerald-500/15 text-emerald-400 rounded">
            {ready} ready to call
          </span>
          {judged.length - ready > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 bg-red-500/15 text-red-400 rounded">
              {judged.length - ready} needs work
            </span>
          )}
        </div>
        <div className="mt-1.5 space-y-1">
          {judged.slice(0, 3).map((j, i) => (
            <div key={i} className="flex items-center gap-2 text-[10px]">
              <span className="text-yellow-300">{String(j.lead_name || `Pitch ${i + 1}`)}</span>
              <span className={`font-bold ${(j.score as number) >= 7 ? "text-emerald-400" : "text-red-400"}`}>
                {String(j.score)}/10
              </span>
              {j.ready_to_call ? (
                <span className="text-emerald-500">✓</span>
              ) : (
                <span className="text-red-500">✗</span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return null;
}

function GradeBadge({ grade, count, color }: { grade: string; count: number; color: string }) {
  const colorMap: Record<string, string> = {
    emerald: "bg-emerald-500/15 text-emerald-400",
    blue: "bg-blue-500/15 text-blue-400",
    yellow: "bg-yellow-500/15 text-yellow-400",
    red: "bg-red-500/15 text-red-400",
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${colorMap[color]}`}>
      {grade}: {count}
    </span>
  );
}
