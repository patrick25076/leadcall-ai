"use client";

import { useState, useEffect, useCallback } from "react";
import { VoiceChatPanel } from "./VoiceChatPanel";

export type VoiceSetupMode = "idle" | "choosing" | "text" | "voice" | "submitted" | "creating";

type VoiceSetupProps = {
  mode: VoiceSetupMode;
  onModeChange: (mode: VoiceSetupMode) => void;
  onSendChat: (message: string) => void;
  running: boolean;
  pipelineState: Record<string, unknown> | null;
  sessionId: string | null;
};

type FormData = {
  caller_name: string;
  pricing_override: string;
  objective: string;
  call_style: string;
  opening_style: string;
  closing_cta: string;
  business_hours: string;
  availability_rules: string;
  additional_context: string;
};

const OBJECTIVES = [
  { value: "book_demo", label: "Book a demo" },
  { value: "qualify_lead", label: "Qualify the lead" },
  { value: "schedule_visit", label: "Schedule a visit" },
  { value: "gather_info", label: "Gather information" },
];

const STYLES = [
  { value: "professional", label: "Professional" },
  { value: "friendly", label: "Friendly" },
  { value: "consultative", label: "Consultative" },
  { value: "assertive", label: "Assertive" },
];

const OPENINGS = [
  { value: "direct", label: "Direct — get to the point" },
  { value: "warm", label: "Warm — build rapport first" },
  { value: "question", label: "Question-led — start with a question" },
];

export function VoiceSetupCard({ mode, onModeChange, onSendChat, running, pipelineState, sessionId }: VoiceSetupProps) {
  const [form, setForm] = useState<FormData>({
    caller_name: "",
    pricing_override: "",
    objective: "book_demo",
    call_style: "professional",
    opening_style: "warm",
    closing_cta: "",
    business_hours: "9:00-18:00 Mon-Fri",
    availability_rules: "",
    additional_context: "",
  });
  const [savedConfig, setSavedConfig] = useState<FormData | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Pre-fill from pipeline state
  useEffect(() => {
    if (!pipelineState) return;
    const analysis = pipelineState.business_analysis as Record<string, unknown> | null;
    const prefs = pipelineState.preferences as Record<string, unknown> | null;

    if (analysis) {
      const pricing = String(analysis.pricing_info || "");
      if (pricing && pricing.toLowerCase() !== "not found" && pricing.toLowerCase() !== "n/a") {
        setForm((f) => ({ ...f, pricing_override: pricing }));
      }
    }
    if (prefs) {
      const vc = prefs.voice_config as Record<string, string> | undefined;
      if (vc?.caller_name) setForm((f) => ({ ...f, caller_name: vc.caller_name }));
      if (vc?.objective) setForm((f) => ({ ...f, objective: vc.objective }));
      if (vc?.call_style) setForm((f) => ({ ...f, call_style: vc.call_style }));
      if (prefs.caller_name) setForm((f) => ({ ...f, caller_name: String(prefs.caller_name) }));
    }
  }, [pipelineState]);

  const handleSubmit = useCallback(async () => {
    if (!form.caller_name.trim()) return;
    setSubmitting(true);

    try {
      const resp = await fetch("/api/voice-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (resp.ok) {
        setSavedConfig({ ...form });
        onModeChange("submitted");
      }
    } catch (err) {
      console.error("Failed to save voice config:", err);
    } finally {
      setSubmitting(false);
    }
  }, [form, onModeChange]);

  const handleCreateAgents = useCallback(() => {
    onModeChange("creating");
    onSendChat("Create the voice agents now using the saved voice configuration. Set up an ElevenLabs agent for each ready lead.");
  }, [onModeChange, onSendChat]);

  const handleVoiceMode = useCallback(() => {
    onModeChange("voice");
  }, [onModeChange]);

  // ─── Idle: Show the CTA button ──────────────────────────────────────────
  if (mode === "idle") {
    return (
      <div className="my-4 mx-2 p-4 rounded-lg border border-pink-500/20 bg-pink-500/5 animate-in"
        style={{ animation: "fadeSlideIn 0.3s ease-out" }}>
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2 h-2 rounded-full bg-pink-400 animate-pulse" />
          <span className="text-xs font-bold text-pink-400 uppercase tracking-wider">
            Pipeline Complete
          </span>
        </div>
        <p className="text-sm text-gray-300 mb-4">
          Leads scored and pitches judged. Ready to set up voice agents for outbound calls.
        </p>
        <button
          onClick={() => onModeChange("choosing")}
          className="w-full py-3 bg-pink-600 hover:bg-pink-500 rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-2"
        >
          <span className="text-lg">🎙️</span>
          Set Up Voice Agents
        </button>
      </div>
    );
  }

  // ─── Choosing: Text vs Voice ────────────────────────────────────────────
  if (mode === "choosing") {
    return (
      <div className="my-4 mx-2 p-4 rounded-lg border border-pink-500/20 bg-pink-500/5 animate-in"
        style={{ animation: "fadeSlideIn 0.3s ease-out" }}>
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2 h-2 rounded-full bg-pink-400" />
          <span className="text-xs font-bold text-pink-400 uppercase tracking-wider">
            Configure Voice Agents
          </span>
        </div>
        <p className="text-xs text-gray-400 mb-4">
          Choose how you want to set up your voice agents:
        </p>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => onModeChange("text")}
            className="p-4 rounded-lg border border-gray-700 bg-[#12121a] hover:border-pink-500/40 hover:bg-pink-500/5 transition-all text-left group"
          >
            <div className="text-2xl mb-2">📝</div>
            <div className="text-sm font-medium text-gray-200 group-hover:text-pink-300">
              Text Form
            </div>
            <div className="text-[10px] text-gray-500 mt-1">
              Fill in a quick questionnaire
            </div>
          </button>
          <button
            onClick={handleVoiceMode}
            className="p-4 rounded-lg border border-gray-700 bg-[#12121a] hover:border-purple-500/40 hover:bg-purple-500/5 transition-all text-left group"
          >
            <div className="text-2xl mb-2">🎤</div>
            <div className="text-sm font-medium text-gray-200 group-hover:text-purple-300">
              Voice Chat
            </div>
            <div className="text-[10px] text-gray-500 mt-1">
              Talk to the agent naturally
            </div>
          </button>
        </div>
        <button
          onClick={() => onModeChange("idle")}
          className="mt-3 text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
        >
          Cancel
        </button>
      </div>
    );
  }

  // ─── Text mode: The questionnaire form ──────────────────────────────────
  if (mode === "text") {
    const analysis = pipelineState?.business_analysis as Record<string, unknown> | null;
    const judged = (pipelineState?.judged_pitches || []) as Array<Record<string, unknown>>;
    const readyCount = judged.filter((p) => p.ready_to_call).length;
    const language = analysis?.language || "English";
    const businessName = analysis?.business_name || "Your Business";

    return (
      <div className="my-4 mx-2 rounded-lg border border-pink-500/20 bg-pink-500/5 overflow-hidden animate-in"
        style={{ animation: "fadeSlideIn 0.3s ease-out" }}>
        {/* Header */}
        <div className="px-4 py-3 border-b border-pink-500/10 bg-pink-500/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm">🎙️</span>
              <span className="text-xs font-bold text-pink-400 uppercase tracking-wider">
                Voice Agent Setup
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-2 py-0.5 bg-emerald-500/15 text-emerald-400 rounded">
                {readyCount} leads ready
              </span>
              <span className="text-[10px] px-2 py-0.5 bg-blue-500/15 text-blue-400 rounded">
                {String(language)}
              </span>
            </div>
          </div>
          <p className="text-[10px] text-gray-500 mt-1">
            Configure how {String(businessName)}'s voice agents will sound and behave
          </p>
        </div>

        {/* Form */}
        <div className="p-4 space-y-4">
          {/* Caller Name — required */}
          <FormField label="Caller Name" required hint="Who should the agent introduce itself as?">
            <input
              type="text"
              value={form.caller_name}
              onChange={(e) => setForm((f) => ({ ...f, caller_name: e.target.value }))}
              placeholder="e.g. Maria, Alex, etc."
              className="w-full bg-[#12121a] border border-gray-700 rounded-lg px-3 py-2 text-[13px] text-gray-200 outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500/20 placeholder-gray-600"
            />
          </FormField>

          {/* Pricing */}
          <FormField
            label="Pricing Info"
            hint={analysis?.pricing_info && String(analysis.pricing_info) !== "Not found"
              ? "Pre-filled from website — edit if needed"
              : "Not found on website — please provide your pricing"}
            required={!analysis?.pricing_info || String(analysis.pricing_info) === "Not found"}
          >
            <textarea
              value={form.pricing_override}
              onChange={(e) => setForm((f) => ({ ...f, pricing_override: e.target.value }))}
              placeholder="e.g. Starting from €50/hour, packages from €500..."
              rows={2}
              className="w-full bg-[#12121a] border border-gray-700 rounded-lg px-3 py-2 text-[13px] text-gray-200 outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500/20 placeholder-gray-600 resize-none"
            />
          </FormField>

          {/* Two columns */}
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Call Objective" required>
              <select
                value={form.objective}
                onChange={(e) => setForm((f) => ({ ...f, objective: e.target.value }))}
                className="w-full bg-[#12121a] border border-gray-700 rounded-lg px-3 py-2 text-[13px] text-gray-200 outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500/20 placeholder-gray-600"
              >
                {OBJECTIVES.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </FormField>

            <FormField label="Call Style">
              <select
                value={form.call_style}
                onChange={(e) => setForm((f) => ({ ...f, call_style: e.target.value }))}
                className="w-full bg-[#12121a] border border-gray-700 rounded-lg px-3 py-2 text-[13px] text-gray-200 outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500/20 placeholder-gray-600"
              >
                {STYLES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </FormField>
          </div>

          {/* Opening */}
          <FormField label="Opening Approach">
            <select
              value={form.opening_style}
              onChange={(e) => setForm((f) => ({ ...f, opening_style: e.target.value }))}
              className="w-full bg-[#12121a] border border-gray-700 rounded-lg px-3 py-2 text-[13px] text-gray-200 outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500/20 placeholder-gray-600"
            >
              {OPENINGS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </FormField>

          {/* CTA */}
          <FormField label="Closing CTA" hint="What should the agent ask for at the end?">
            <input
              type="text"
              value={form.closing_cta}
              onChange={(e) => setForm((f) => ({ ...f, closing_cta: e.target.value }))}
              placeholder="e.g. Can I schedule a 15-minute demo this week?"
              className="w-full bg-[#12121a] border border-gray-700 rounded-lg px-3 py-2 text-[13px] text-gray-200 outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500/20 placeholder-gray-600"
            />
          </FormField>

          {/* Business Hours */}
          <FormField label="Business Hours">
            <input
              type="text"
              value={form.business_hours}
              onChange={(e) => setForm((f) => ({ ...f, business_hours: e.target.value }))}
              className="w-full bg-[#12121a] border border-gray-700 rounded-lg px-3 py-2 text-[13px] text-gray-200 outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500/20 placeholder-gray-600"
            />
          </FormField>

          {/* Availability Rules */}
          <FormField label="Availability / Booking Rules" hint="When are you available for meetings? Any scheduling preferences?">
            <input
              type="text"
              value={form.availability_rules}
              onChange={(e) => setForm((f) => ({ ...f, availability_rules: e.target.value }))}
              placeholder="e.g. Available Tue-Thu 10:00-16:00, book via calendly.com/..."
              className="w-full bg-[#12121a] border border-gray-700 rounded-lg px-3 py-2 text-[13px] text-gray-200 outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500/20 placeholder-gray-600"
            />
          </FormField>

          {/* Additional Context */}
          <FormField label="Additional Context" hint="Optional — promotions, special offers, notes">
            <textarea
              value={form.additional_context}
              onChange={(e) => setForm((f) => ({ ...f, additional_context: e.target.value }))}
              placeholder="Anything else the voice agent should know..."
              rows={2}
              className="w-full bg-[#12121a] border border-gray-700 rounded-lg px-3 py-2 text-[13px] text-gray-200 outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500/20 placeholder-gray-600 resize-none"
            />
          </FormField>

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <button
              onClick={handleSubmit}
              disabled={!form.caller_name.trim() || submitting}
              className="flex-1 py-2.5 bg-pink-600 hover:bg-pink-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm font-semibold transition-colors"
            >
              {submitting ? "Saving..." : "Save Configuration"}
            </button>
            <button
              onClick={() => onModeChange("choosing")}
              className="px-4 py-2.5 border border-gray-700 hover:border-gray-600 rounded-lg text-xs text-gray-400 transition-colors"
            >
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Submitted: Confirmation summary ────────────────────────────────────
  if (mode === "submitted" && savedConfig) {
    const analysis = pipelineState?.business_analysis as Record<string, unknown> | null;
    const judged = (pipelineState?.judged_pitches || []) as Array<Record<string, unknown>>;
    const readyCount = judged.filter((p) => p.ready_to_call).length;

    return (
      <div className="my-4 mx-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 overflow-hidden animate-in"
        style={{ animation: "fadeSlideIn 0.3s ease-out" }}>
        <div className="px-4 py-3 border-b border-emerald-500/10 bg-emerald-500/5">
          <div className="flex items-center gap-2">
            <span className="text-sm">✅</span>
            <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
              Voice Config Saved
            </span>
          </div>
        </div>

        <div className="p-4 space-y-2">
          <SummaryRow label="Business" value={String(analysis?.business_name || "")} />
          <SummaryRow label="Caller" value={savedConfig.caller_name} />
          <SummaryRow label="Language" value={String(analysis?.language || "")} />
          <SummaryRow label="Style" value={savedConfig.call_style} />
          <SummaryRow label="Objective" value={OBJECTIVES.find((o) => o.value === savedConfig.objective)?.label || savedConfig.objective} />
          {savedConfig.pricing_override ? (
            <SummaryRow label="Pricing" value={savedConfig.pricing_override.slice(0, 80) + (savedConfig.pricing_override.length > 80 ? "..." : "")} />
          ) : null}
          <SummaryRow label="Ready Leads" value={`${readyCount} leads with phone numbers`} />
          {savedConfig.closing_cta ? (
            <SummaryRow label="CTA" value={savedConfig.closing_cta} />
          ) : null}

          <div className="flex gap-2 pt-3">
            <button
              onClick={handleCreateAgents}
              disabled={running}
              className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm font-bold transition-colors flex items-center justify-center gap-2"
            >
              <span>📞</span>
              {running ? "Creating..." : "Create Voice Agents"}
            </button>
            <button
              onClick={() => onModeChange("text")}
              className="px-4 py-3 border border-gray-700 hover:border-gray-600 rounded-lg text-xs text-gray-400 transition-colors"
            >
              Edit
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Creating / Voice: handled by chat, show status ─────────────────────
  if (mode === "creating") {
    return (
      <div className="my-4 mx-2 p-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5 animate-in"
        style={{ animation: "fadeSlideIn 0.3s ease-out" }}>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
            Creating Voice Agents
          </span>
        </div>
        <p className="text-xs text-gray-400 mt-2">
          The call manager is creating ElevenLabs agents for each ready lead. Watch the trace above...
        </p>
      </div>
    );
  }

  if (mode === "voice") {
    return (
      <VoiceChatPanel
        sessionId={sessionId}
        onClose={() => onModeChange("idle")}
        onConfigSaved={() => {
          onModeChange("submitted");
        }}
      />
    );
  }

  return null;
}

/* ─── Sub-components ──────────────────────────────────────────────────────── */

function FormField({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-gray-300 mb-1">
        {label}
        {required ? <span className="text-pink-400 ml-0.5">*</span> : null}
      </label>
      {children}
      {hint ? (
        <p className="text-[9px] text-gray-600 mt-0.5">{hint}</p>
      ) : null}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 text-xs">
      <span className="text-gray-500 w-20 shrink-0">{label}</span>
      <span className="text-gray-200">{value}</span>
    </div>
  );
}
