"use client";

import { useEffect, useRef, useMemo } from "react";
import type { AgentEvent } from "@/app/page";

const AGENT_COLORS: Record<string, string> = {
  leadcall_orchestrator: "text-purple-400",
  website_analyzer: "text-cyan-400",
  lead_finder: "text-orange-400",
  lead_scorer: "text-blue-400",
  pitch_generator: "text-green-400",
  pitch_judge: "text-yellow-400",
  call_manager: "text-red-400",
  preferences_agent: "text-teal-400",
  voice_config_agent: "text-pink-400",
  analysis_pipeline: "text-indigo-400",
  you: "text-white",
  system: "text-gray-400",
};

const AGENT_BG: Record<string, string> = {
  leadcall_orchestrator: "border-l-purple-500/30",
  website_analyzer: "border-l-cyan-500/30",
  lead_finder: "border-l-orange-500/30",
  lead_scorer: "border-l-blue-500/30",
  pitch_generator: "border-l-green-500/30",
  pitch_judge: "border-l-yellow-500/30",
  call_manager: "border-l-red-500/30",
  preferences_agent: "border-l-teal-500/30",
  voice_config_agent: "border-l-pink-500/30",
  analysis_pipeline: "border-l-indigo-500/30",
  you: "border-l-white/30",
  system: "border-l-gray-500/30",
};

const AGENT_GLOW: Record<string, string> = {
  leadcall_orchestrator: "bg-purple-500/5",
  website_analyzer: "bg-cyan-500/5",
  lead_finder: "bg-orange-500/5",
  lead_scorer: "bg-blue-500/5",
  pitch_generator: "bg-green-500/5",
  pitch_judge: "bg-yellow-500/5",
  call_manager: "bg-red-500/5",
  preferences_agent: "bg-teal-500/5",
  voice_config_agent: "bg-pink-500/5",
  analysis_pipeline: "bg-indigo-500/5",
  you: "bg-white/5",
  system: "bg-gray-500/5",
};

/* ─── Lightweight Markdown → HTML ────────────────────────────────────────── */

function renderMarkdown(text: string): string {
  // Escape HTML
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong class="text-gray-200 font-semibold">$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong class="text-gray-200 font-semibold">$1</strong>');

  // Italic: *text* or _text_
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/_(.+?)_/g, "<em>$1</em>");

  // Bullet lists: lines starting with * or -
  html = html.replace(
    /^[\*\-]\s+(.+)$/gm,
    '<div class="flex gap-2 ml-2"><span class="text-emerald-500/60 shrink-0">&#8226;</span><span>$1</span></div>'
  );

  // Numbered lists: lines starting with 1. 2. etc.
  html = html.replace(
    /^(\d+)\.\s+(.+)$/gm,
    '<div class="flex gap-2 ml-2"><span class="text-emerald-500/60 shrink-0 font-mono text-[10px]">$1.</span><span>$2</span></div>'
  );

  // Headers: lines starting with # ## ###
  html = html.replace(
    /^###\s+(.+)$/gm,
    '<div class="text-[13px] font-semibold text-gray-200 mt-2 mb-1">$1</div>'
  );
  html = html.replace(
    /^##\s+(.+)$/gm,
    '<div class="text-sm font-semibold text-gray-100 mt-2.5 mb-1">$1</div>'
  );
  html = html.replace(
    /^#\s+(.+)$/gm,
    '<div class="text-[15px] font-bold text-white mt-3 mb-1.5">$1</div>'
  );

  // Line breaks → <br> (preserve paragraph breaks)
  html = html.replace(/\n\n/g, '<div class="h-2"></div>');
  html = html.replace(/\n/g, "<br/>");

  return html;
}

function formatToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return "";
  const str = JSON.stringify(args, null, 2);
  return str.length > 300 ? str.slice(0, 300) + "..." : str;
}

function formatToolResult(result: unknown): string {
  if (!result) return "";
  const str = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return str.length > 500 ? str.slice(0, 500) + "..." : str;
}

export function TracePanel({
  events,
  activeAgent,
  children,
}: {
  events: AgentEvent[];
  activeAgent: string | null;
  children?: React.ReactNode;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll as events arrive
  useEffect(() => {
    if (containerRef.current) {
      const el = containerRef.current;
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
      if (isNearBottom) {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }
    }
  }, [events]);

  // Always scroll on new agent
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeAgent]);

  return (
    <div ref={containerRef} className="p-4">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4 sticky top-0 bg-[#0a0a0f] py-2 z-10">
        Agent Trace Log
        <span className="text-gray-600 font-normal ml-2">
          {events.length} events
        </span>
      </h2>

      {events.length === 0 ? (
        <div className="text-center text-gray-600 mt-20">
          <p className="text-lg mb-2">No events yet</p>
          <p className="text-xs">
            Enter a URL above to start the multi-agent pipeline
          </p>
        </div>
      ) : (
        <div className="space-y-0.5">
          {events.map((event, i) => (
            <div
              key={i}
              className="animate-in"
              style={{
                animation: "fadeSlideIn 0.2s ease-out",
              }}
            >
              <EventRow event={event} index={i} />
            </div>
          ))}
        </div>
      )}

      {/* Live typing indicator */}
      {activeAgent && (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-gray-500 py-2">
          <span className={AGENT_COLORS[activeAgent] || "text-gray-400"}>
            {activeAgent.replace(/_/g, " ")}
          </span>
          <span className="flex gap-0.5">
            <span className="w-1 h-1 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1 h-1 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1 h-1 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
          </span>
        </div>
      )}

      {/* Inline interactive cards (e.g. Voice Setup) */}
      {children}

      <div ref={bottomRef} />

      <style jsx>{`
        @keyframes fadeSlideIn {
          from {
            opacity: 0;
            transform: translateY(4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}

function EventRow({ event, index }: { event: AgentEvent; index: number }) {
  const author = event.author || "system";
  const agentColor = AGENT_COLORS[author] || "text-gray-400";
  const borderColor = AGENT_BG[author] || "border-l-gray-700";
  const glowColor = AGENT_GLOW[author] || "bg-gray-500/5";

  if (event.type === "agent_transfer") {
    return (
      <div className="flex items-center gap-2 py-1.5 px-3 bg-indigo-500/5 border-l-2 border-l-indigo-500/50 rounded-r text-[11px]">
        <span className="text-indigo-400 font-medium">TRANSFER</span>
        <span className={agentColor}>{author.replace(/_/g, " ")}</span>
        <span className="text-gray-500">&rarr;</span>
        <span className="text-indigo-300 font-medium">
          {(event.target_agent || "").replace(/_/g, " ")}
        </span>
      </div>
    );
  }

  if (event.type === "tool_call") {
    return (
      <div
        className={`py-1.5 px-3 bg-yellow-500/5 border-l-2 ${borderColor} rounded-r`}
      >
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-yellow-500/80 font-mono text-[10px]">fn</span>
          <span className={agentColor}>
            {author.replace(/_/g, " ")}
          </span>
          <span className="text-gray-600">&rarr;</span>
          <span className="text-yellow-300 font-medium">{event.tool_name}</span>
        </div>
        {event.tool_args && Object.keys(event.tool_args).length > 0 ? (
          <details className="mt-1 ml-6">
            <summary className="text-[9px] text-gray-600 cursor-pointer hover:text-gray-400">
              Show parameters
            </summary>
            <pre className="text-[10px] text-gray-500 mt-1 bg-[#0a0a10] rounded p-2 overflow-x-auto max-h-24 overflow-y-auto">
              {formatToolArgs(event.tool_args)}
            </pre>
          </details>
        ) : null}
      </div>
    );
  }

  if (event.type === "tool_result") {
    const resultStr = formatToolResult(event.tool_result);
    const result = event.tool_result as Record<string, unknown> | undefined;
    const status = result?.status as string | undefined;
    const isSuccess = status === "success";

    return (
      <div
        className={`py-1.5 px-3 ${
          isSuccess ? "bg-emerald-500/5" : "bg-red-500/5"
        } border-l-2 ${borderColor} rounded-r`}
      >
        <div className="flex items-center gap-2 text-[11px]">
          <span
            className={`font-mono text-[10px] ${
              isSuccess ? "text-emerald-500" : "text-red-500"
            }`}
          >
            {isSuccess ? "OK" : "ERR"}
          </span>
          <span className="text-gray-500">{event.tool_name}</span>
          {result?.count !== undefined ? (
            <span className="text-gray-400 ml-1">
              ({String(result.count)} results)
            </span>
          ) : null}
          {result?.pages_crawled !== undefined ? (
            <span className="text-gray-400 ml-1">
              ({String(result.pages_crawled)} pages)
            </span>
          ) : null}
          {result?.total_leads !== undefined ? (
            <span className="text-gray-400 ml-1">
              ({String(result.total_leads)} leads scored)
            </span>
          ) : null}
          {result?.ready_to_call !== undefined ? (
            <span className="text-emerald-400 ml-1">
              ({String(result.ready_to_call)} ready)
            </span>
          ) : null}
        </div>
        {resultStr ? (
          <details className="mt-1 ml-6">
            <summary className="text-[9px] text-gray-600 cursor-pointer hover:text-gray-400">
              Show full response
            </summary>
            <pre className="text-[10px] text-gray-500 bg-[#0a0a10] rounded p-2 overflow-x-auto max-h-40 overflow-y-auto mt-1">
              {resultStr}
            </pre>
          </details>
        ) : null}
      </div>
    );
  }

  // ─── Text event — agent speaking (THE MAIN MESSAGE) ───────────────────
  if (event.is_partial) return null;

  // User messages
  if (author === "you") {
    return (
      <div className="py-3 px-4 my-1 border-l-2 border-l-white/20 bg-white/5 rounded-r-lg">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[10px] font-bold text-white/80 uppercase tracking-wider">You</span>
        </div>
        <div className="text-sm text-gray-200 leading-relaxed">
          {event.content}
        </div>
      </div>
    );
  }

  // System messages (errors, retries)
  if (author === "system") {
    return (
      <div className="py-2 px-3 my-0.5 border-l-2 border-l-gray-600/30 bg-gray-500/5 rounded-r">
        <div className="text-[11px] text-gray-400 italic">
          {event.content}
        </div>
      </div>
    );
  }

  // Agent text messages — these are the main output, render them BIG and formatted
  return (
    <div
      className={`py-3 px-4 my-1.5 border-l-2 ${borderColor} ${glowColor} rounded-r-lg`}
    >
      {/* Agent label */}
      <div className="flex items-center gap-2 mb-2">
        <div className={`w-1.5 h-1.5 rounded-full ${
          AGENT_COLORS[author]?.includes("purple") ? "bg-purple-400" :
          AGENT_COLORS[author]?.includes("cyan") ? "bg-cyan-400" :
          AGENT_COLORS[author]?.includes("orange") ? "bg-orange-400" :
          AGENT_COLORS[author]?.includes("blue") ? "bg-blue-400" :
          AGENT_COLORS[author]?.includes("green") ? "bg-green-400" :
          AGENT_COLORS[author]?.includes("yellow") ? "bg-yellow-400" :
          AGENT_COLORS[author]?.includes("red") ? "bg-red-400" :
          AGENT_COLORS[author]?.includes("teal") ? "bg-teal-400" :
          "bg-gray-400"
        }`} />
        <span className={`text-[10px] font-bold uppercase tracking-wider ${agentColor}`}>
          {author.replace(/_/g, " ")}
        </span>
      </div>

      {/* Rich formatted content */}
      <div
        className="text-[13px] text-gray-300 leading-relaxed agent-message"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(event.content || "") }}
      />
    </div>
  );
}
