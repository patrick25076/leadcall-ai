"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { PipelineView } from "@/components/PipelineView";
import { TracePanel } from "@/components/TracePanel";
import { StatePanel } from "@/components/StatePanel";
import { VoiceSetupCard, type VoiceSetupMode } from "@/components/VoiceSetupCard";

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

export type PipelineStep = {
  agent: string;
  status: "pending" | "active" | "done" | "error";
  events: AgentEvent[];
};

const PIPELINE_AGENTS = [
  "website_analyzer",
  "lead_finder",
  "lead_scorer",
  "pitch_generator",
  "pitch_judge",
];

// ─── LocalStorage helpers ──────────────────────────────────────────────────

function saveToStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(`leadcall_${key}`, JSON.stringify(value));
  } catch {}
}

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`leadcall_${key}`);
    if (raw) return JSON.parse(raw) as T;
  } catch {}
  return fallback;
}

// ─── Component ─────────────────────────────────────────────────────────────

export default function Home() {
  const [url, setUrl] = useState("");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [steps, setSteps] = useState<PipelineStep[]>([]);
  const [pipelineState, setPipelineState] = useState<Record<string, unknown> | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [pipelineComplete, setPipelineComplete] = useState(false);
  const [voiceSetupMode, setVoiceSetupMode] = useState<VoiceSetupMode>("idle");

  // ─── Restore from localStorage on mount ────────────────────────────────
  useEffect(() => {
    const savedEvents = loadFromStorage<AgentEvent[]>("events", []);
    const savedSteps = loadFromStorage<PipelineStep[]>("steps", []);
    const savedSession = loadFromStorage<string | null>("sessionId", null);
    const savedUrl = loadFromStorage<string>("url", "");

    if (savedEvents.length > 0) setEvents(savedEvents);
    if (savedSteps.length > 0) setSteps(savedSteps);
    if (savedSession) setSessionId(savedSession);
    if (savedUrl) setUrl(savedUrl);

    // Always fetch latest state from server
    fetch("/api/state")
      .then((r) => r.json())
      .then((state) => {
        if (state && (state.business_analysis || state.leads?.length || state.scored_leads?.length)) {
          setPipelineState(state);
          // If judged pitches exist, pipeline was completed before
          if (state.judged_pitches?.length > 0) {
            setPipelineComplete(true);
          }
        }
      })
      .catch(() => {});

    const savedVoiceMode = loadFromStorage<VoiceSetupMode>("voiceSetupMode", "idle");
    if (savedVoiceMode !== "idle") setVoiceSetupMode(savedVoiceMode);

    setHydrated(true);
  }, []);

  // ─── Persist to localStorage on change ─────────────────────────────────
  useEffect(() => {
    if (!hydrated) return;
    saveToStorage("events", events);
  }, [events, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    saveToStorage("steps", steps);
  }, [steps, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    saveToStorage("sessionId", sessionId);
  }, [sessionId, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    saveToStorage("url", url);
  }, [url, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    saveToStorage("voiceSetupMode", voiceSetupMode);
  }, [voiceSetupMode, hydrated]);

  const initSteps = useCallback(() => {
    return PIPELINE_AGENTS.map((agent) => ({
      agent,
      status: "pending" as const,
      events: [],
    }));
  }, []);

  // ─── Shared SSE stream reader ──────────────────────────────────────────
  const readStream = useCallback(
    async (response: Response) => {
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

        let gotPipelineComplete = false;

        for (const line of lines) {
          if (line.startsWith("data:")) {
            const dataStr = line.slice(5).trim();
            if (!dataStr) continue;
            try {
              const data = JSON.parse(dataStr);

              // Session event
              if (data.session_id) {
                setSessionId(data.session_id as string);
                continue;
              }

              const event = data as AgentEvent;

              // Track active agent
              if (event.author && event.author !== "system") {
                setActiveAgent(event.author);
              }

              // Add event to trace log
              setEvents((prev) => [...prev, event]);

              // Update pipeline steps
              setSteps((prev) => {
                const newSteps = [...prev];
                const stepIndex = newSteps.findIndex(
                  (s) => s.agent === event.author
                );
                if (stepIndex >= 0) {
                  newSteps[stepIndex] = {
                    ...newSteps[stepIndex],
                    status: "active",
                    events: [...newSteps[stepIndex].events, event],
                  };
                  for (let i = 0; i < stepIndex; i++) {
                    if (newSteps[i].status === "active") {
                      newSteps[i] = { ...newSteps[i], status: "done" };
                    }
                  }
                }
                return newSteps;
              });

              // Refresh state after tool results
              if (event.type === "tool_result") {
                fetch("/api/state")
                  .then((r) => r.json())
                  .then((state) => setPipelineState(state))
                  .catch(() => {});
              }
            } catch {}
          } else if (line.startsWith("event:")) {
            const eventType = line.slice(6).trim();
            if (eventType === "pipeline_complete") {
              gotPipelineComplete = true;
            }
          }
        }

        if (gotPipelineComplete) {
          setPipelineComplete(true);
          fetch("/api/state")
            .then((r) => r.json())
            .then((state) => {
              setPipelineState(state);
              setSteps((prev) =>
                prev.map((s) =>
                  s.events.length > 0 && s.status !== "done"
                    ? { ...s, status: "done" }
                    : s
                )
              );
            })
            .catch(() => {});
        }
      }
    },
    []
  );

  // ─── Actions ───────────────────────────────────────────────────────────
  const startAnalysis = useCallback(async () => {
    if (!url.trim() || running) return;
    setRunning(true);
    setEvents([]);
    setSteps(initSteps());
    setPipelineState(null);
    setActiveAgent(null);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), session_id: sessionId }),
      });
      await readStream(response);
    } catch (err) {
      console.error("Stream error:", err);
    } finally {
      setRunning(false);
      setActiveAgent(null);
    }
  }, [url, running, sessionId, initSteps, readStream]);

  const sendChat = useCallback(async () => {
    if (!chatInput.trim() || running) return;
    setRunning(true);
    const message = chatInput;
    setChatInput("");

    // Add user message to trace
    const userEvent: AgentEvent = {
      type: "text",
      author: "you",
      timestamp: new Date().toISOString(),
      content: message,
    };
    setEvents((prev) => [...prev, userEvent]);

    try {
      let response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, session_id: sessionId }),
      });

      // If session expired/lost, retry without session_id to auto-create a new one
      if (!response.ok) {
        console.warn("Session may have expired, creating new session...");
        response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, session_id: null }),
        });
      }

      await readStream(response);
    } catch (err) {
      console.error("Chat error:", err);
    } finally {
      setRunning(false);
      setActiveAgent(null);
    }
  }, [chatInput, running, sessionId, readStream]);

  // Programmatic chat send (for VoiceSetupCard)
  const sendChatMessage = useCallback(async (message: string) => {
    if (!message.trim() || running) return;
    setRunning(true);

    const userEvent: AgentEvent = {
      type: "text",
      author: "you",
      timestamp: new Date().toISOString(),
      content: message,
    };
    setEvents((prev) => [...prev, userEvent]);

    try {
      let response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, session_id: sessionId }),
      });

      if (!response.ok) {
        response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, session_id: null }),
        });
      }

      await readStream(response);
    } catch (err) {
      console.error("Chat error:", err);
    } finally {
      setRunning(false);
      setActiveAgent(null);
    }
  }, [running, sessionId, readStream]);

  const resetPipeline = useCallback(async () => {
    await fetch("/api/reset", { method: "POST" });
    setEvents([]);
    setSteps(initSteps());
    setPipelineState(null);
    setSessionId(null);
    setActiveAgent(null);
    setPipelineComplete(false);
    setVoiceSetupMode("idle");
    // Clear localStorage
    try {
      localStorage.removeItem("leadcall_events");
      localStorage.removeItem("leadcall_steps");
      localStorage.removeItem("leadcall_sessionId");
      localStorage.removeItem("leadcall_url");
      localStorage.removeItem("leadcall_voiceSetupMode");
    } catch {}
  }, [initSteps]);

  // ─── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-3 flex items-center gap-4 bg-[#0d0d14]">
        <h1 className="text-lg font-bold text-emerald-400 tracking-tight">
          LeadCall AI
        </h1>
        <span className="text-xs text-gray-500">Multi-Agent SDR Platform</span>
        <div className="ml-auto flex items-center gap-3">
          {running && activeAgent && (
            <span className="flex items-center gap-2 text-xs">
              <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
              <span className="text-emerald-400 font-medium">
                {activeAgent.replace(/_/g, " ")}
              </span>
              <span className="text-gray-500">is working...</span>
            </span>
          )}
          {running && !activeAgent && (
            <span className="flex items-center gap-1.5 text-xs text-yellow-400">
              <span className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
              Starting...
            </span>
          )}
          <button
            onClick={resetPipeline}
            className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1 border border-gray-800 rounded"
          >
            Reset
          </button>
        </div>
      </header>

      {/* URL Input Bar */}
      <div className="border-b border-gray-800 px-6 py-4 bg-[#0d0d14]">
        <div className="flex gap-3 max-w-4xl">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && startAnalysis()}
            placeholder="Enter business URL (e.g. https://icetrust.ro)"
            className="flex-1 bg-[#12121a] border border-gray-700 rounded-lg px-4 py-2.5 text-sm
              placeholder-gray-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/30"
          />
          <button
            onClick={startAnalysis}
            disabled={running || !url.trim()}
            className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500
              rounded-lg text-sm font-medium transition-colors"
          >
            {running ? "Running..." : "Analyze & Find Leads"}
          </button>
        </div>
      </div>

      {/* Main Content — 3 columns */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Pipeline Steps */}
        <div className="w-80 border-r border-gray-800 overflow-y-auto bg-[#0b0b12]">
          <PipelineView steps={steps} pipelineState={pipelineState} />
        </div>

        {/* Center: Trace Log */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            <TracePanel events={events} activeAgent={activeAgent}>
              {/* Voice Setup Card — appears after pipeline completes */}
              {pipelineComplete && voiceSetupMode !== "creating" && (
                <VoiceSetupCard
                  mode={voiceSetupMode}
                  onModeChange={setVoiceSetupMode}
                  onSendChat={sendChatMessage}
                  running={running}
                  pipelineState={pipelineState}
                  sessionId={sessionId}
                />
              )}
              {voiceSetupMode === "creating" && (
                <VoiceSetupCard
                  mode="creating"
                  onModeChange={setVoiceSetupMode}
                  onSendChat={sendChatMessage}
                  running={running}
                  pipelineState={pipelineState}
                  sessionId={sessionId}
                />
              )}
            </TracePanel>
          </div>

          {/* Chat input — always enabled after pipeline */}
          <div className="border-t border-gray-800 bg-[#0d0d14] p-4">
            <div className="flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendChat()}
                placeholder={
                  sessionId
                    ? "Chat with orchestrator (e.g. 'set up voice agents', 'make calls')"
                    : "Run the pipeline first, then chat here..."
                }
                disabled={!sessionId}
                className="flex-1 bg-[#12121a] border border-gray-700 rounded px-3 py-2 text-sm
                  placeholder-gray-600 focus:outline-none focus:border-emerald-500
                  disabled:opacity-40"
              />
              <button
                onClick={sendChat}
                disabled={running || !chatInput.trim() || !sessionId}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600
                  rounded text-sm transition-colors"
              >
                Send
              </button>
            </div>
          </div>
        </div>

        {/* Right: State Panel */}
        <div className="w-96 border-l border-gray-800 overflow-y-auto bg-[#0b0b12]">
          <StatePanel pipelineState={pipelineState} />
        </div>
      </div>
    </div>
  );
}
