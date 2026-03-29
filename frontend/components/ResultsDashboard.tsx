"use client";

type Call = Record<string, unknown>;
type Lead = Record<string, unknown>;
type Agent = Record<string, unknown>;

interface ResultsDashboardProps {
  calls: Call[];
  leads: Lead[];
  agents: Agent[];
}

export default function ResultsDashboard({ calls, leads, agents }: ResultsDashboardProps) {
  const completed = calls.filter((c) => c.status === "completed");
  const inProgress = calls.filter((c) => c.status === "initiated" || c.status === "ringing" || c.status === "in-progress");

  // Extract outcomes from call analysis
  const meetingsBooked = calls.filter((c) => {
    const analysis = c.analysis as Record<string, unknown> | undefined;
    const collected = analysis?.collected_data as Record<string, unknown> | undefined;
    return collected?.meeting_booked === true || collected?.meeting_booked === "yes";
  });

  const interested = calls.filter((c) => {
    const analysis = c.analysis as Record<string, unknown> | undefined;
    const evaluation = analysis?.evaluation_results as Record<string, unknown> | undefined;
    return evaluation?.lead_interest === "high" || evaluation?.lead_interest === "medium";
  });

  if (calls.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-zinc-400 text-lg mb-2">No results yet</p>
          <p className="text-zinc-600 text-sm">Results will appear here after calls or emails are sent.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto space-y-8">

        {/* Stats Grid */}
        <div className="grid grid-cols-4 gap-4">
          <StatCard label="Total Calls" value={calls.length} icon="📞" />
          <StatCard label="Completed" value={completed.length} icon="✅" color="emerald" />
          <StatCard label="Meetings Booked" value={meetingsBooked.length} icon="📅" color="blue" />
          <StatCard label="Interested" value={interested.length} icon="🎯" color="amber" />
        </div>

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

              const statusColor: Record<string, string> = {
                completed: "bg-emerald-500/20 text-emerald-400",
                initiated: "bg-amber-500/20 text-amber-400",
                ringing: "bg-blue-500/20 text-blue-400",
                "in-progress": "bg-blue-500/20 text-blue-400",
                failed: "bg-red-500/20 text-red-400",
                "no-answer": "bg-zinc-700/50 text-zinc-400",
              };

              return (
                <div key={i} className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
                  <div className="flex items-center gap-4 mb-3">
                    <div className="flex-1">
                      <p className="text-white font-medium">
                        {String(call.lead_name || call.phone_number || `Call #${i + 1}`)}
                      </p>
                      <p className="text-zinc-500 text-xs">
                        {String(call.phone_number || "Unknown number")}
                        {call.duration_seconds ? ` · ${Math.round(Number(call.duration_seconds) / 60)}min ${Number(call.duration_seconds) % 60}s` : ""}
                        {call.duration ? ` · ${String(call.duration)}s` : ""}
                      </p>
                    </div>
                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                      statusColor[String(call.status)] || statusColor.initiated
                    }`}>
                      {String(call.status || "unknown")}
                    </span>
                  </div>

                  {/* Analysis Results */}
                  {evaluation ? (
                    <div className="flex gap-4 mb-3">
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
                  ) : null}

                  {/* Collected Data */}
                  <CollectedDataBadges data={collected} />

                  {/* Summary */}
                  {analysis?.summary ? (
                    <p className="text-sm text-zinc-400 mb-3">{String(analysis.summary)}</p>
                  ) : null}

                  {/* Transcript Preview */}
                  {transcript && transcript.length > 0 && (
                    <details className="group">
                      <summary className="text-xs text-zinc-600 cursor-pointer hover:text-zinc-400 transition-colors">
                        View transcript ({transcript.length} messages)
                      </summary>
                      <div className="mt-2 space-y-1 max-h-60 overflow-y-auto">
                        {transcript.map((t, j) => (
                          <div key={j} className="text-xs">
                            <span className={`font-medium ${t.role === "agent" ? "text-emerald-500" : "text-blue-400"}`}>
                              {t.role === "agent" ? "Agent" : "Lead"}:
                            </span>{" "}
                            <span className="text-zinc-400">{t.message}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon, color = "zinc" }: { label: string; value: number; icon: string; color?: string }) {
  const colors: Record<string, string> = {
    zinc: "border-zinc-800",
    emerald: "border-emerald-500/30",
    blue: "border-blue-500/30",
    amber: "border-amber-500/30",
  };
  return (
    <div className={`bg-zinc-900/60 border ${colors[color]} rounded-xl p-4 text-center`}>
      <span className="text-2xl">{icon}</span>
      <p className="text-2xl font-bold text-white mt-1">{value}</p>
      <p className="text-xs text-zinc-500">{label}</p>
    </div>
  );
}

function CollectedDataBadges({ data }: { data: Record<string, unknown> | null }) {
  if (!data) return null;
  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {data.meeting_booked != null && (
        <span className="text-xs bg-emerald-500/10 text-emerald-400 px-2 py-1 rounded">
          Meeting: {String(data.meeting_booked)}
        </span>
      )}
      {data.callback_requested != null && (
        <span className="text-xs bg-amber-500/10 text-amber-400 px-2 py-1 rounded">
          Callback: {String(data.callback_requested)}
        </span>
      )}
      {data.lead_objections != null && (
        <span className="text-xs bg-red-500/10 text-red-400 px-2 py-1 rounded">
          Objections: {String(data.lead_objections).slice(0, 60)}
        </span>
      )}
    </div>
  );
}

function ResultBadge({ label, value }: { label: string; value: string }) {
  const v = String(value).toLowerCase();
  const isGood = v === "yes" || v === "high" || v === "excellent" || v === "true";
  const isMedium = v === "medium" || v === "moderate" || v === "partial";
  return (
    <div className="text-xs">
      <span className="text-zinc-500">{label}: </span>
      <span className={isGood ? "text-emerald-400" : isMedium ? "text-amber-400" : "text-zinc-400"}>
        {value}
      </span>
    </div>
  );
}
