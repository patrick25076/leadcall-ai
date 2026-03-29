"use client";

import { useState, useEffect, useRef } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "";

type Voice = {
  voice_id: string;
  name: string;
  description: string;
  language: string;
  gender: string;
  accent: string;
  age: string;
  use_case: string;
  preview_url: string;
  category: string;
};

interface VoiceSelectorProps {
  selectedVoiceId: string;
  onSelect: (voiceId: string, voiceName: string) => void;
  language?: string;
}

export default function VoiceSelector({ selectedVoiceId, onSelect, language }: VoiceSelectorProps) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "male" | "female">("all");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const fetchVoices = async () => {
      try {
        const url = language
          ? `${API}/api/voices?language=${language}`
          : `${API}/api/voices`;
        const resp = await fetch(url);
        if (resp.ok) {
          const data = await resp.json();
          setVoices(data.voices || []);
        }
      } catch {
        // Silently fail
      } finally {
        setLoading(false);
      }
    };
    fetchVoices();
  }, [language]);

  const playPreview = (voice: Voice) => {
    if (playingId === voice.voice_id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    if (!voice.preview_url) return;

    if (audioRef.current) {
      audioRef.current.pause();
    }
    const audio = new Audio(voice.preview_url);
    audioRef.current = audio;
    audio.play();
    setPlayingId(voice.voice_id);
    audio.onended = () => setPlayingId(null);
  };

  const filtered = voices.filter((v) => {
    if (filter === "all") return true;
    return v.gender === filter;
  });

  if (loading) {
    return (
      <div className="p-4 text-center text-zinc-500 text-sm">Loading voices...</div>
    );
  }

  return (
    <div>
      {/* Filter */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs text-zinc-500">Filter:</span>
        {(["all", "male", "female"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-xs px-3 py-1 rounded-full transition-colors ${
              filter === f
                ? "bg-emerald-500/20 text-emerald-400"
                : "bg-zinc-800 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {f === "all" ? "All" : f === "male" ? "Male" : "Female"}
          </button>
        ))}
        <span className="text-xs text-zinc-600 ml-auto">{filtered.length} voices</span>
      </div>

      {/* Voice Grid */}
      <div className="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto">
        {filtered.map((v) => (
          <button
            key={v.voice_id}
            onClick={() => onSelect(v.voice_id, v.name)}
            className={`text-left p-3 rounded-lg border transition-all ${
              selectedVoiceId === v.voice_id
                ? "border-emerald-500 bg-emerald-500/10"
                : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-600"
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium text-zinc-200">{v.name}</span>
              {v.preview_url ? (
                <button
                  onClick={(e) => { e.stopPropagation(); playPreview(v); }}
                  className="text-xs text-zinc-500 hover:text-emerald-400 transition-colors"
                  title="Play preview"
                >
                  {playingId === v.voice_id ? "■" : "▶"}
                </button>
              ) : null}
            </div>
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              {v.gender ? <span>{v.gender}</span> : null}
              {v.accent ? <span>· {v.accent}</span> : null}
              {v.age ? <span>· {v.age}</span> : null}
            </div>
            {v.use_case ? (
              <p className="text-xs text-zinc-600 mt-1 truncate">{v.use_case}</p>
            ) : null}
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="text-zinc-600 text-sm text-center py-4">No voices found for this filter.</p>
      )}
    </div>
  );
}
