"use client";

import { useState, useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api";
import VoiceSelector from "./VoiceSelector";

type Pitch = Record<string, unknown>;
type Agent = Record<string, unknown>;

const API = process.env.NEXT_PUBLIC_API_URL || "";

interface OutreachPanelProps {
  pitches: Pitch[];
  agents: Agent[];
  pipelineState: Record<string, unknown> | null;
  sessionId: string | null;
  campaignId?: number;
  onRefreshState?: () => void;
}

type SetupStep = "not_started" | "voice_setup" | "creating" | "testing" | "approving";

export default function OutreachPanel({ pitches, agents, pipelineState, sessionId, campaignId, onRefreshState }: OutreachPanelProps) {
  const [setupStep, setSetupStep] = useState<SetupStep>(agents.length > 0 ? "testing" : "not_started");
  const [testPhone, setTestPhone] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [testingCall, setTestingCall] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [selectedVoiceId, setSelectedVoiceId] = useState("JBFqnCBsd6RMkjVDRZzb");
  const [selectedVoiceName, setSelectedVoiceName] = useState("George");
  const [showVoiceSelector, setShowVoiceSelector] = useState(false);
  const [approvedLeads, setApprovedLeads] = useState<Set<string>>(new Set());
  const [batchStatus, setBatchStatus] = useState<string | null>(null);
  const [selectedLeads, setSelectedLeads] = useState<Set<number>>(new Set());

  // Voice setup via WebSocket (native audio)
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState<Array<{ role: string; text: string }>>([]);
  const [voiceStatus, setVoiceStatus] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const micCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nextPlayTimeRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const readyToCall = pitches.filter((p) => p.ready_to_call);
  const readyToEmail = pitches.filter((p) => p.ready_to_email || p.email_subject);

  // Auto-scroll transcript
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [voiceTranscript]);

  // Update step when agents appear
  useEffect(() => {
    if (agents.length > 0 && setupStep === "creating") {
      setSetupStep("testing");
    }
  }, [agents.length, setupStep]);

  const stopMicrophone = () => {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    micCtxRef.current?.close();
    processorRef.current = null;
    sourceRef.current = null;
    streamRef.current = null;
    micCtxRef.current = null;
  };

  const resetPlayback = () => {
    nextPlayTimeRef.current = 0;
  };

  const stopPlayback = () => {
    resetPlayback();
    playbackCtxRef.current?.close();
    playbackCtxRef.current = null;
  };

  // Start voice setup conversation
  const startVoiceSetup = async () => {
    setSetupStep("voice_setup");
    setVoiceActive(true);
    setVoiceTranscript([]);
    setVoiceStatus("Connecting...");

    const wsBase = API.replace("http", "ws").replace("https", "wss") || "ws://localhost:8000";
    const voiceSessionId = `voice_${Date.now()}`;
    const ws = new WebSocket(`${wsBase}/ws/voice-config/${voiceSessionId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setVoiceStatus("Connected — speak to set up your voice agent");
      startMicrophone();
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "transcript") {
        setVoiceTranscript((prev) => [...prev, { role: msg.author || "agent", text: msg.text }]);
      } else if (msg.type === "audio") {
        playAudio(msg.data, msg.mime_type);
      } else if (msg.type === "tool_call") {
        if (msg.tool_name === "create_elevenlabs_agent") {
          setVoiceStatus("Creating voice agents...");
        } else if (msg.tool_name === "configure_voice_agent") {
          setVoiceStatus("Saving your preferences...");
        }
      } else if (msg.type === "tool_result") {
        if (msg.tool_name === "configure_voice_agent") {
          setVoiceStatus("Campaign voice config saved — next select the leads for agent creation.");
        }
      } else if (msg.type === "turn_complete") {
        resetPlayback();
      }
    };

    ws.onclose = () => {
      setVoiceActive(false);
      stopMicrophone();
      // Only mark complete if we actually had a conversation
      setVoiceTranscript((prev) => {
        if (prev.length > 0) {
          setVoiceStatus("Voice setup complete");
          setSetupStep("creating");
        } else {
          setVoiceStatus("Connection closed — try again");
        }
        return prev;
      });
    };

    ws.onerror = () => {
      setVoiceActive(false);
      stopMicrophone();
      setVoiceStatus("Connection error — try again");
    };
  };

  const startMicrophone = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ctx = new AudioContext({ sampleRate: 16000 });
      micCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      sourceRef.current = source;
      processorRef.current = processor;

      source.connect(processor);
      processor.connect(ctx.destination);

      processor.onaudioprocess = (e) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const float32 = e.inputBuffer.getChannelData(0);
          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            int16[i] = Math.max(-32768, Math.min(32767, Math.floor(float32[i] * 32768)));
          }
          wsRef.current.send(int16.buffer);
        }
      };
    } catch {
      setVoiceStatus("Microphone access denied");
    }
  };

  const parseSampleRate = (mimeType?: string): number => {
    if (!mimeType) return 24000;
    const match = mimeType.match(/rate=(\d+)/);
    return match ? parseInt(match[1], 10) : 24000;
  };

  const playAudio = (base64Data: string, mimeType?: string) => {
    try {
      const rate = parseSampleRate(mimeType);
      if (!playbackCtxRef.current || playbackCtxRef.current.sampleRate !== rate) {
        playbackCtxRef.current?.close();
        playbackCtxRef.current = new AudioContext({ sampleRate: rate });
        nextPlayTimeRef.current = 0;
      }
      const ctx = playbackCtxRef.current;

      const raw = atob(base64Data);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) {
        bytes[i] = raw.charCodeAt(i);
      }

      // Gemini Live audio chunks arrive as 16-bit PCM, not Float32 samples.
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }

      const audioBuffer = ctx.createBuffer(1, float32.length, rate);
      audioBuffer.getChannelData(0).set(float32);
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const startTime = Math.max(ctx.currentTime, nextPlayTimeRef.current);
      source.start(startTime);
      nextPlayTimeRef.current = startTime + audioBuffer.duration;
    } catch {}
  };

  const stopVoiceSetup = () => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    stopMicrophone();
    stopPlayback();
    setVoiceActive(false);
    if (agents.length > 0) {
      setSetupStep("testing");
    } else {
      setSetupStep("creating");
    }
  };

  // Use text chat to create agents (fallback if voice doesn't work)
  const createAgentsViaChat = async () => {
    const leadsToCreate = selectedLeads.size > 0
      ? Array.from(selectedLeads).map((i) => String(readyToCall[i]?.lead_name)).filter(Boolean)
      : readyToCall.map((p) => String(p.lead_name));

    setVoiceStatus(`Creating ${leadsToCreate.length} agent${leadsToCreate.length !== 1 ? "s" : ""}...`);
    try {
      const resp = await apiFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Create ElevenLabs voice agents for these specific leads only: ${leadsToCreate.join(", ")}. Use the business analysis and voice config we already have.`,
          session_id: sessionId,
        }),
      });
      // Read stream for completion
      const reader = resp.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
      // Refresh state to pick up newly created agents
      onRefreshState?.();
      // Poll a few times to ensure agents appear in state
      let polls = 0;
      const pollInterval = setInterval(() => {
        onRefreshState?.();
        polls++;
        if (polls >= 5) clearInterval(pollInterval);
      }, 2000);
      setSetupStep("testing");
      setVoiceStatus("Agents created! Test them below.");
    } catch {
      setVoiceStatus("Failed to create agents. Try again.");
    }
  };

  // Test call
  const handleTestCall = async () => {
    if (!testPhone.trim()) return;
    setTestingCall(true);
    setTestResult(null);

    const firstAgent = agents[0];
    if (!firstAgent) {
      setTestResult("No voice agents created yet. Complete the setup first.");
      setTestingCall(false);
      return;
    }

    try {
      const resp = await apiFetch("/api/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: firstAgent.agent_id,
          phone_number: testPhone,
        }),
      });
      const data = await resp.json();
      if (data.status === "success") {
        setTestResult("Calling your phone now! Answer to hear the AI agent.");
      } else {
        setTestResult(String(data.error || data.detail || "Could not start call"));
      }
    } catch {
      setTestResult("Connection error. Check backend is running.");
    }
    setTestingCall(false);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto space-y-6">

        {/* Progress Steps */}
        <div className="flex items-center gap-2 mb-2">
          {[
            { key: "voice_setup", label: "Voice Setup" },
            { key: "creating", label: "Create Agents" },
            { key: "testing", label: "Test" },
            { key: "approving", label: "Approve & Launch" },
          ].map((s, i) => {
            const steps: SetupStep[] = ["voice_setup", "creating", "testing", "approving"];
            const currentIdx = steps.indexOf(setupStep === "not_started" ? "voice_setup" : setupStep);
            const stepIdx = i;
            const isDone = stepIdx < currentIdx;
            const isActive = stepIdx === currentIdx;

            return (
              <div key={s.key} className="flex items-center gap-2">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium ${
                  isDone ? "bg-emerald-500/20 text-emerald-400" :
                  isActive ? "bg-emerald-500 text-white" :
                  "bg-zinc-800 text-zinc-500"
                }`}>
                  {isDone ? "✓" : i + 1}
                </div>
                <span className={`text-xs ${isActive ? "text-white" : "text-zinc-500"}`}>{s.label}</span>
                {i < 3 && <div className={`w-6 h-px ${isDone ? "bg-emerald-500/40" : "bg-zinc-800"}`} />}
              </div>
            );
          })}
        </div>

        {/* Step 1: Voice Setup (not started) */}
        {setupStep === "not_started" && (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-6">
            <div className="text-center mb-6">
              <h2 className="text-xl font-semibold text-white mb-2">Set Up Your Voice Agent</h2>
              <p className="text-zinc-400 text-sm max-w-md mx-auto">
                Choose a voice, then configure how your AI calls leads.
              </p>
            </div>

            {/* Voice Selection */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-zinc-300">Voice</h3>
                <button
                  onClick={() => setShowVoiceSelector(!showVoiceSelector)}
                  className="text-xs text-emerald-400 hover:text-emerald-300"
                >
                  {showVoiceSelector ? "Hide voices" : "Change voice"}
                </button>
              </div>
              {!showVoiceSelector ? (
                <div className="flex items-center gap-3 p-3 bg-zinc-800/30 rounded-lg">
                  <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center text-sm">
                    {selectedVoiceName[0]}
                  </div>
                  <div>
                    <p className="text-sm text-white font-medium">{selectedVoiceName}</p>
                    <p className="text-xs text-zinc-500">Selected voice</p>
                  </div>
                </div>
              ) : (
                <VoiceSelector
                  selectedVoiceId={selectedVoiceId}
                  onSelect={(id, name) => {
                    setSelectedVoiceId(id);
                    setSelectedVoiceName(name);
                    setShowVoiceSelector(false);
                    // Save voice to preferences
                    apiFetch("/api/voice-config", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ voice_id: id }),
                    }).catch(() => {});
                  }}
                  language={String((pipelineState as Record<string, Record<string, string>> | null)?.business_analysis?.language_code || "")}
                />
              )}
            </div>

            <div className="flex flex-col gap-3 max-w-xs mx-auto">
              <button
                onClick={startVoiceSetup}
                className="bg-emerald-600 text-white font-medium py-3 px-6 rounded-xl hover:bg-emerald-500 transition-colors flex items-center justify-center gap-2"
              >
                Start Voice Setup
              </button>
              <button
                onClick={createAgentsViaChat}
                className="text-zinc-500 text-sm py-2 hover:text-zinc-300 transition-colors"
              >
                Or set up via text instead
              </button>
            </div>
          </div>
        )}

        {/* Step 1b: Voice Setup (active conversation) */}
        {setupStep === "voice_setup" && (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                {voiceActive && (
                  <div className="w-3 h-3 bg-emerald-400 rounded-full animate-pulse" />
                )}
                <h3 className="text-white font-medium">Voice Setup</h3>
                <span className="text-zinc-500 text-xs">{voiceStatus}</span>
              </div>
              <button
                onClick={stopVoiceSetup}
                className="text-xs text-zinc-500 hover:text-zinc-300 px-3 py-1.5 border border-zinc-700 rounded-lg"
              >
                {voiceActive ? "End conversation" : "Done"}
              </button>
            </div>

            {/* Visual indicator */}
            {voiceActive && (
              <div className="flex justify-center my-6">
                <div className="relative">
                  <div className="w-20 h-20 rounded-full bg-emerald-500/10 flex items-center justify-center">
                    <div className="w-14 h-14 rounded-full bg-emerald-500/20 flex items-center justify-center animate-pulse">
                      <span className="text-2xl">🎤</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Transcript */}
            <div ref={scrollRef} className="max-h-64 overflow-y-auto space-y-2 mt-4">
              {voiceTranscript.map((t, i) => (
                <div key={i} className={`text-sm p-2 rounded-lg ${
                  t.role === "agent" || t.role === "voice_config_live"
                    ? "bg-zinc-800/50 text-zinc-300"
                    : "bg-emerald-500/10 text-emerald-300 text-right"
                }`}>
                  {t.text}
                </div>
              ))}
              {voiceTranscript.length === 0 && voiceActive && (
                <p className="text-zinc-600 text-sm text-center">Listening... speak to configure your voice agent</p>
              )}
            </div>
          </div>
        )}

        {/* Step 2: Creating agents — select which leads */}
        {setupStep === "creating" && (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-6">
            <div className="text-center mb-4">
              <h3 className="text-lg font-medium text-white mb-1">Select Leads for Voice Agents</h3>
              <p className="text-zinc-400 text-sm">
                Choose which qualified leads should get personalized voice agents.
              </p>
            </div>

            {readyToCall.length > 0 && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-zinc-500">{selectedLeads.size} of {readyToCall.length} selected</span>
                  <button
                    onClick={() => {
                      if (selectedLeads.size === readyToCall.length) {
                        setSelectedLeads(new Set());
                      } else {
                        setSelectedLeads(new Set(readyToCall.map((_, i) => i)));
                      }
                    }}
                    className="text-xs text-emerald-400 hover:text-emerald-300"
                  >
                    {selectedLeads.size === readyToCall.length ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                  {readyToCall.map((p, i) => (
                    <label
                      key={i}
                      className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                        selectedLeads.has(i)
                          ? "bg-emerald-500/10 border border-emerald-500/20"
                          : "bg-zinc-800/30 border border-transparent hover:border-zinc-700"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedLeads.has(i)}
                        onChange={() => {
                          setSelectedLeads((prev) => {
                            const next = new Set(prev);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          });
                        }}
                        className="accent-emerald-500"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white font-medium truncate">{String(p.lead_name)}</p>
                        <p className="text-xs text-zinc-500 truncate">{String(p.phone || "No phone")}</p>
                      </div>
                      {p.score != null && (
                        <span className="text-xs text-zinc-500">{String(p.score)}/10</span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={createAgentsViaChat}
              disabled={selectedLeads.size === 0}
              className="w-full bg-emerald-600 text-white font-medium py-3 px-8 rounded-xl hover:bg-emerald-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Create {selectedLeads.size} Voice Agent{selectedLeads.size !== 1 ? "s" : ""}
            </button>
            {voiceStatus && (
              <p className="text-zinc-500 text-xs mt-3 text-center">{voiceStatus}</p>
            )}
          </div>
        )}

        {/* Step 3: Testing */}
        {setupStep === "testing" && (
          <div className="bg-zinc-900/60 border border-emerald-500/20 rounded-xl p-6">
            <h3 className="text-lg font-medium text-white mb-1">Test Your Voice Agent</h3>
            <p className="text-zinc-400 text-sm mb-4">
              {agents.length} agent{agents.length !== 1 ? "s" : ""} created. Call yourself to hear exactly what your leads will hear.
            </p>

            <div className="flex gap-3 mb-4">
              <input
                type="tel"
                placeholder="Your phone (e.g. +40733...)"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
              />
              <button
                onClick={handleTestCall}
                disabled={testingCall || !testPhone.trim()}
                className="bg-emerald-600 text-white font-medium px-6 py-3 rounded-xl hover:bg-emerald-500 transition-colors disabled:opacity-50 whitespace-nowrap"
              >
                {testingCall ? "Calling..." : "📞 Call Me"}
              </button>
            </div>

            {testResult && (
              <div className={`p-3 rounded-lg text-sm mb-4 ${
                testResult.includes("error") || testResult.includes("Failed") || testResult.includes("No voice")
                  ? "bg-red-500/10 border border-red-500/20 text-red-400"
                  : "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
              }`}>
                {testResult}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => setSetupStep("approving")}
                className="flex-1 bg-emerald-600 text-white font-medium py-2.5 rounded-xl hover:bg-emerald-500 transition-colors"
              >
                Sounds good — proceed to approve
              </button>
              <button
                onClick={() => setSetupStep("voice_setup")}
                className="text-zinc-500 text-sm px-4 py-2.5 hover:text-zinc-300 transition-colors"
              >
                Re-configure
              </button>
            </div>

            {/* Agent list */}
            {agents.length > 0 && (
              <div className="mt-4 space-y-2">
                {agents.map((a, i) => (
                  <div key={i} className="flex items-center gap-3 p-3 bg-zinc-800/30 rounded-lg">
                    <span>🎙️</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium truncate">{String(a.name)}</p>
                      <p className="text-zinc-600 text-xs">{String(a.language || "")}</p>
                    </div>
                    <a
                      href={`https://elevenlabs.io/app/conversational-ai/agents/${String(a.agent_id)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-zinc-500 hover:text-zinc-300"
                    >
                      Open ↗
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 4: Approve & Launch */}
        {setupStep === "approving" && (
          <>
            {/* Calls to approve */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-white font-medium">Approve Outbound Calls ({readyToCall.length})</h3>
                {readyToCall.length > 0 && (
                  <button
                    onClick={async () => {
                      if (!campaignId) return;
                      setBatchStatus("Launching calls...");
                      // Approve all if none explicitly approved
                      const toCall = approvedLeads.size > 0
                        ? readyToCall.filter((p) => approvedLeads.has(String(p.lead_name)))
                        : readyToCall;
                      try {
                        const resp = await apiFetch(`/api/campaigns/${campaignId}/batch-call`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            lead_ids: toCall.map((_, i) => i),
                            delay_seconds: 30,
                          }),
                        });
                        const data = await resp.json();
                        setBatchStatus(`${data.total_calls} calls queued! Calling every 30 seconds.`);
                      } catch {
                        setBatchStatus("Failed to start batch calls.");
                      }
                    }}
                    disabled={!!batchStatus}
                    className="text-xs bg-emerald-600 text-white px-4 py-1.5 rounded-lg hover:bg-emerald-500 transition-colors disabled:opacity-50"
                  >
                    {approvedLeads.size > 0 ? `Launch ${approvedLeads.size} Approved` : "Approve All & Launch"}
                  </button>
                )}
              </div>

              {batchStatus ? (
                <div className="mb-4 p-3 rounded-lg text-sm bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                  {batchStatus}
                </div>
              ) : null}

              <div className="space-y-2">
                {readyToCall.map((p, i) => {
                  const name = String(p.lead_name);
                  const isApproved = approvedLeads.has(name);
                  return (
                    <div key={i} className={`flex items-center gap-4 p-3 rounded-lg transition-colors ${
                      isApproved ? "bg-emerald-500/5 border border-emerald-500/20" : "bg-zinc-800/30"
                    }`}>
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-sm font-medium">{name}</p>
                        <p className="text-zinc-500 text-xs">
                          {String(p.contact_person || "No contact")} · {String(p.phone_number || "No phone")}
                        </p>
                      </div>
                      <span className="text-xs text-zinc-500">{String(p.score || 0)}/10</span>
                      <button
                        onClick={() => {
                          const next = new Set(approvedLeads);
                          if (isApproved) next.delete(name); else next.add(name);
                          setApprovedLeads(next);
                        }}
                        className={`text-xs px-3 py-1.5 rounded transition-colors ${
                          isApproved
                            ? "bg-emerald-600 text-white"
                            : "bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30"
                        }`}
                      >
                        {isApproved ? "Approved" : "Approve"}
                      </button>
                      <button
                        onClick={() => {
                          const next = new Set(approvedLeads);
                          next.delete(name);
                          setApprovedLeads(next);
                        }}
                        className="text-xs text-zinc-600 hover:text-red-400 px-2 py-1.5"
                      >
                        Skip
                      </button>
                    </div>
                  );
                })}
                {readyToCall.length === 0 && (
                  <p className="text-zinc-600 text-sm">No leads ready to call. Check the Leads tab.</p>
                )}
              </div>
            </div>

            {/* Emails to approve */}
            {readyToEmail.length > 0 && (
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-white font-medium">Approve Emails ({readyToEmail.length})</h3>
                  <button
                    onClick={async () => {
                      if (!campaignId) return;
                      setBatchStatus("Sending emails...");
                      try {
                        const resp = await apiFetch(`/api/campaigns/${campaignId}/batch-email`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ lead_names: [] }),
                        });
                        const data = await resp.json();
                        setBatchStatus(`${data.sent} emails sent, ${data.errors} failed.`);
                      } catch {
                        setBatchStatus("Failed to send emails.");
                      }
                    }}
                    className="text-xs bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-500 transition-colors"
                  >
                    Send All Emails
                  </button>
                </div>
                <div className="space-y-2">
                  {readyToEmail.map((p, i) => (
                    <details key={i} className="group">
                      <summary className="flex items-center gap-4 p-3 bg-zinc-800/30 rounded-lg cursor-pointer hover:bg-zinc-800/50 transition-colors">
                        <div className="flex-1 min-w-0">
                          <p className="text-white text-sm font-medium">{String(p.lead_name)}</p>
                          <p className="text-zinc-400 text-xs truncate">Subject: {String(p.email_subject || "")}</p>
                        </div>
                        <svg className="w-4 h-4 text-zinc-500 group-open:rotate-180 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </summary>
                      <div className="mt-2 p-4 bg-zinc-800/20 rounded-lg text-sm text-zinc-400 whitespace-pre-wrap">
                        {String(p.email_body || "No email body generated.")}
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            )}

            {/* Test email on yourself */}
            <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-5">
              <h3 className="text-white font-medium mb-3">Test Email on Yourself</h3>
              <div className="flex gap-3">
                <input
                  type="email"
                  placeholder="Your email"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={async () => {
                    if (!testEmail.trim() || !readyToEmail[0]) return;
                    const first = readyToEmail[0];
                    try {
                      const resp = await apiFetch("/api/chat", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          message: `Send a test email to ${testEmail} with subject "${String(first.email_subject)}" and the email body for ${String(first.lead_name)}.`,
                          session_id: sessionId,
                        }),
                      });
                      if (resp.ok) setTestResult("Test email sent! Check your inbox.");
                    } catch {
                      setTestResult("Failed to send test email.");
                    }
                  }}
                  className="text-xs bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-500 transition-colors"
                >
                  Send Test
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
