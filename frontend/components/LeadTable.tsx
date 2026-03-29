"use client";

import { useState, useMemo, Fragment } from "react";

type Lead = Record<string, unknown>;
type Pitch = Record<string, unknown>;

interface LeadTableProps {
  leads: Lead[];
  pitches: Pitch[];
  pipelineState: Record<string, unknown> | null;
}

type SortKey = "lead_score" | "name" | "score_grade" | "city" | "industry";
type Filter = "all" | "A" | "B" | "C" | "D" | "has_phone" | "has_email";

export default function LeadTable({ leads, pitches, pipelineState }: LeadTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("lead_score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expandedLead, setExpandedLead] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Build pitch lookup
  const pitchByLead = useMemo(() => {
    const map: Record<string, Pitch> = {};
    for (const p of pitches) {
      map[p.lead_name as string] = p;
    }
    return map;
  }, [pitches]);

  // Filter & sort
  const filtered = useMemo(() => {
    let result = [...leads];

    if (search) {
      const q = search.toLowerCase();
      result = result.filter((l) =>
        (l.name as string || "").toLowerCase().includes(q) ||
        (l.contact_person as string || "").toLowerCase().includes(q) ||
        (l.industry as string || "").toLowerCase().includes(q) ||
        (l.city as string || "").toLowerCase().includes(q)
      );
    }

    if (filter === "has_phone") result = result.filter((l) => l.phone);
    else if (filter === "has_email") result = result.filter((l) => l.email);
    else if (filter !== "all") result = result.filter((l) => l.score_grade === filter);

    result.sort((a, b) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "desc" ? bv - av : av - bv;
      }
      return sortDir === "desc"
        ? String(bv).localeCompare(String(av))
        : String(av).localeCompare(String(bv));
    });

    return result;
  }, [leads, search, filter, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(sortDir === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const toggleSelect = (i: number) => {
    const next = new Set(selected);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setSelected(next);
  };

  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((_, i) => i)));
  };

  const gradeColor: Record<string, string> = {
    A: "bg-emerald-500/20 text-emerald-400",
    B: "bg-blue-500/20 text-blue-400",
    C: "bg-amber-500/20 text-amber-400",
    D: "bg-zinc-700/50 text-zinc-400",
  };

  if (leads.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-zinc-400 text-lg mb-2">No leads yet</p>
          <p className="text-zinc-600 text-sm">Leads will appear here after the analysis runs.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="border-b border-zinc-800 px-6 py-3 flex items-center gap-3 bg-[#0d0d14]">
        <input
          type="text"
          placeholder="Search leads..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-zinc-800/50 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500 w-48"
        />

        <div className="flex gap-1">
          {(["all", "A", "B", "C", "D", "has_phone"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
                filter === f
                  ? "bg-emerald-500/20 text-emerald-400"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              {f === "all" ? "All" : f === "has_phone" ? "Has Phone" : `Grade ${f}`}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && (
            <span className="text-xs text-zinc-400">{selected.size} selected</span>
          )}
          <span className="text-xs text-zinc-600">{filtered.length} leads</span>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full">
          <thead className="sticky top-0 bg-[#0d0d14] z-10">
            <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
              <th className="px-4 py-2.5 w-10">
                <input
                  type="checkbox"
                  checked={selected.size === filtered.length && filtered.length > 0}
                  onChange={toggleAll}
                  className="rounded border-zinc-600 bg-zinc-800"
                />
              </th>
              <th className="px-4 py-2.5 cursor-pointer hover:text-zinc-300" onClick={() => toggleSort("name")}>
                Company {sortKey === "name" && (sortDir === "desc" ? "↓" : "↑")}
              </th>
              <th className="px-4 py-2.5 cursor-pointer hover:text-zinc-300" onClick={() => toggleSort("score_grade")}>
                Grade {sortKey === "score_grade" && (sortDir === "desc" ? "↓" : "↑")}
              </th>
              <th className="px-4 py-2.5 cursor-pointer hover:text-zinc-300" onClick={() => toggleSort("lead_score")}>
                Score {sortKey === "lead_score" && (sortDir === "desc" ? "↓" : "↑")}
              </th>
              <th className="px-4 py-2.5">Contact</th>
              <th className="px-4 py-2.5">Phone</th>
              <th className="px-4 py-2.5 cursor-pointer hover:text-zinc-300" onClick={() => toggleSort("industry")}>
                Industry
              </th>
              <th className="px-4 py-2.5 cursor-pointer hover:text-zinc-300" onClick={() => toggleSort("city")}>
                City
              </th>
              <th className="px-4 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((lead, i) => {
              const name = (lead.name as string) || "";
              const pitch = pitchByLead[name];
              const isExpanded = expandedLead === name;

              return (
                <Fragment key={`lead-${i}`}>
                  <tr
                    onClick={() => setExpandedLead(isExpanded ? null : name)}
                    className={`border-b border-zinc-800/50 cursor-pointer transition-colors ${
                      isExpanded ? "bg-zinc-800/30" : "hover:bg-zinc-900/50"
                    }`}
                  >
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(i)}
                        onChange={() => toggleSelect(i)}
                        className="rounded border-zinc-600 bg-zinc-800"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-white text-sm font-medium">{name}</p>
                      {lead.website ? (
                        <p className="text-zinc-600 text-xs truncate max-w-48">{String(lead.website)}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-bold px-2 py-0.5 rounded ${gradeColor[lead.score_grade as string] || gradeColor.D}`}>
                        {String(lead.score_grade || "?")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-400">{Number(lead.lead_score) || 0}</td>
                    <td className="px-4 py-3 text-sm text-zinc-400">{String(lead.contact_person || "-")}</td>
                    <td className="px-4 py-3">
                      {lead.phone ? (
                        <span className="text-xs text-emerald-400">{String(lead.phone)}</span>
                      ) : (
                        <span className="text-xs text-zinc-600">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-500">{String(lead.industry || "-")}</td>
                    <td className="px-4 py-3 text-sm text-zinc-500">{String(lead.city || "-")}</td>
                    <td className="px-4 py-3">
                      {pitch?.ready_to_call ? (
                        <span className="text-xs text-emerald-400">Ready</span>
                      ) : (
                        <span className="text-xs text-zinc-600">Pending</span>
                      )}
                    </td>
                  </tr>

                  {/* Expanded Row: Show pitch & actions */}
                  {isExpanded && (
                    <tr key={`detail-${i}`} className="bg-zinc-800/20">
                      <td colSpan={9} className="px-4 py-4">
                        <div className="grid grid-cols-2 gap-6 max-w-4xl ml-10">
                          {/* Pitch Script */}
                          <div>
                            <p className="text-xs text-zinc-500 mb-2 font-medium">Call Script</p>
                            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-300 leading-relaxed">
                              {String(pitch?.pitch_script || pitch?.revised_pitch || "No pitch generated yet")}
                            </div>
                            {pitch?.score ? (
                              <p className="text-xs text-zinc-600 mt-1">
                                Quality score: {Number(pitch.score)}/10
                                {pitch.feedback ? ` — ${String(pitch.feedback).slice(0, 80)}` : ""}
                              </p>
                            ) : null}
                          </div>

                          {/* Email Draft */}
                          <div>
                            <p className="text-xs text-zinc-500 mb-2 font-medium">Email Draft</p>
                            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-300 leading-relaxed">
                              {pitch?.email_subject ? (
                                <p className="font-medium text-white mb-2">Subject: {String(pitch.email_subject)}</p>
                              ) : null}
                              {String(pitch?.email_body || "No email draft yet")}
                            </div>
                          </div>

                          {/* Lead Details */}
                          <div className="col-span-2">
                            <p className="text-xs text-zinc-500 mb-2 font-medium">Why this lead</p>
                            <p className="text-sm text-zinc-400">{String(lead.relevance_reason || "Matched your ICP")}</p>

                            {/* Score Breakdown */}
                            {lead.score_breakdown ? (
                              <div className="flex flex-wrap gap-3 mt-2">
                                {Object.entries(lead.score_breakdown as Record<string, string>).map(([k, v]) => (
                                  <span key={k} className="text-xs bg-zinc-800 px-2 py-1 rounded text-zinc-400">
                                    {k}: {v}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
