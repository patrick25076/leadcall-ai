"use client";

import { useState, useEffect, useRef, useCallback } from "react";

type VoiceChatProps = {
  sessionId: string | null;
  onClose: () => void;
  onConfigSaved: () => void;
};

type Transcript = {
  author: "you" | "agent" | "system";
  text: string;
};

const WS_BASE = typeof window !== "undefined"
  ? `ws://${window.location.hostname}:8000`
  : "ws://localhost:8000";

export function VoiceChatPanel({ sessionId, onClose, onConfigSaved }: VoiceChatProps) {
  const [connected, setConnected] = useState(false);
  const [listening, setListening] = useState(false);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll transcripts
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcripts]);

  // ─── Audio Playback ───────────────────────────────────────────────────
  const playAudioChunk = useCallback((pcmBase64: string) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: 24000 });
    }
    const ctx = audioContextRef.current;

    // Decode base64 to Int16 PCM
    const raw = atob(pcmBase64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);

    // Convert Int16 to Float32
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    playQueueRef.current.push(float32);
    setAgentSpeaking(true);

    if (!isPlayingRef.current) {
      drainPlayQueue(ctx);
    }
  }, []);

  const drainPlayQueue = useCallback((ctx: AudioContext) => {
    if (playQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      setAgentSpeaking(false);
      return;
    }
    isPlayingRef.current = true;

    const samples = playQueueRef.current.shift()!;
    const buffer = ctx.createBuffer(1, samples.length, 24000);
    buffer.getChannelData(0).set(samples);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => drainPlayQueue(ctx);
    source.start();
  }, []);

  // ─── Microphone Capture (16kHz mono PCM) ──────────────────────────────
  const startMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const ctx = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContextRef.current || ctx;
      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      // ScriptProcessor to capture raw PCM (4096 samples per buffer)
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const float32 = e.inputBuffer.getChannelData(0);
        // Convert Float32 → Int16
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Send as binary
        wsRef.current.send(int16.buffer);
      };

      source.connect(processor);
      processor.connect(ctx.destination); // Required for ScriptProcessor to work
      setListening(true);
    } catch (err) {
      setError("Microphone access denied. Please allow microphone access.");
      console.error("Mic error:", err);
    }
  }, []);

  const stopMic = useCallback(() => {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    processorRef.current = null;
    sourceRef.current = null;
    streamRef.current = null;
    setListening(false);
  }, []);

  // ─── WebSocket Connection ─────────────────────────────────────────────
  const connect = useCallback(() => {
    const sid = sessionId || `voice_${Date.now()}`;
    const ws = new WebSocket(`${WS_BASE}/ws/voice-config/${sid}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setError(null);
      setTranscripts([{ author: "system", text: "Connected. Starting microphone..." }]);
      startMic();
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);

        if (msg.type === "audio") {
          playAudioChunk(msg.data);
        } else if (msg.type === "transcript") {
          const author = msg.author === "voice_config_live" || msg.author === "voice_config_agent"
            ? "agent" : msg.author === "user" ? "you" : "agent";
          setTranscripts((prev) => [...prev, { author, text: msg.text }]);
        } else if (msg.type === "tool_call") {
          setTranscripts((prev) => [...prev, {
            author: "system",
            text: `Using tool: ${msg.tool_name}...`,
          }]);
        } else if (msg.type === "tool_result") {
          if (msg.tool_name === "configure_voice_agent") {
            onConfigSaved();
          }
        } else if (msg.type === "turn_complete") {
          setAgentSpeaking(false);
        } else if (msg.type === "error") {
          setError(msg.message);
        }
      } catch {}
    };

    ws.onerror = () => {
      setError("WebSocket connection failed. Is the backend running on port 8000?");
    };

    ws.onclose = () => {
      setConnected(false);
      stopMic();
    };
  }, [sessionId, startMic, stopMic, playAudioChunk, onConfigSaved]);

  // Connect on mount
  useEffect(() => {
    connect();
    return () => {
      stopMic();
      wsRef.current?.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const disconnect = useCallback(() => {
    stopMic();
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({ type: "close" }));
      wsRef.current.close();
    }
    onClose();
  }, [stopMic, onClose]);

  return (
    <div className="my-4 mx-2 rounded-lg border border-purple-500/20 bg-purple-500/5 overflow-hidden"
      style={{ animation: "fadeSlideIn 0.3s ease-out" }}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-purple-500/10 bg-purple-500/5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`w-2.5 h-2.5 rounded-full ${connected ? "bg-purple-400 animate-pulse" : "bg-gray-600"}`} />
            <span className="text-xs font-bold text-purple-400 uppercase tracking-wider">
              Live Voice Config
            </span>
          </div>
          <button
            onClick={disconnect}
            className="text-[10px] text-gray-500 hover:text-gray-300 px-2 py-1 border border-gray-700 rounded transition-colors"
          >
            End Session
          </button>
        </div>
      </div>

      {/* Visualizer / Status */}
      <div className="px-4 py-6 flex flex-col items-center gap-3">
        {/* Audio visualizer rings */}
        <div className="relative w-20 h-20 flex items-center justify-center">
          <div className={`absolute inset-0 rounded-full border-2 ${agentSpeaking ? "border-purple-400 animate-ping" : "border-gray-700"} opacity-30`} />
          <div className={`absolute inset-2 rounded-full border-2 ${listening ? "border-purple-500" : "border-gray-700"} ${agentSpeaking ? "animate-pulse" : ""}`} />
          <div className={`w-12 h-12 rounded-full flex items-center justify-center ${agentSpeaking ? "bg-purple-500/30" : listening ? "bg-purple-500/15" : "bg-gray-800"}`}>
            <span className="text-xl">{agentSpeaking ? "🔊" : listening ? "🎤" : "⏸"}</span>
          </div>
        </div>

        <div className="text-center">
          <div className={`text-xs font-medium ${agentSpeaking ? "text-purple-400" : listening ? "text-gray-300" : "text-gray-500"}`}>
            {agentSpeaking ? "Agent is speaking..." : listening ? "Listening to you..." : "Connecting..."}
          </div>
          {error ? (
            <div className="text-[10px] text-red-400 mt-1">{error}</div>
          ) : null}
        </div>

        {/* Mic toggle */}
        <div className="flex gap-2">
          <button
            onClick={listening ? stopMic : startMic}
            className={`px-4 py-1.5 rounded text-xs font-medium transition-colors ${listening ? "bg-red-500/20 text-red-400 hover:bg-red-500/30" : "bg-purple-500/20 text-purple-400 hover:bg-purple-500/30"}`}
          >
            {listening ? "Mute" : "Unmute"}
          </button>
        </div>
      </div>

      {/* Live Transcript */}
      <div className="border-t border-purple-500/10 px-4 py-3 max-h-48 overflow-y-auto">
        <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-2">Live Transcript</div>
        <div className="space-y-1.5">
          {transcripts.map((t, i) => (
            <div key={i} className={`text-[11px] ${t.author === "you" ? "text-gray-300" : t.author === "agent" ? "text-purple-300" : "text-gray-500 italic"}`}>
              <span className={`font-medium mr-1 ${t.author === "you" ? "text-white/60" : t.author === "agent" ? "text-purple-400" : "text-gray-600"}`}>
                {t.author === "you" ? "You:" : t.author === "agent" ? "Agent:" : ""}
              </span>
              {t.text}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
