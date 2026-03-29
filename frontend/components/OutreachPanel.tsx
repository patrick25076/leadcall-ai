"use client";

import { useState } from "react";

type Pitch = Record<string, unknown>;
type Agent = Record<string, unknown>;

const API = process.env.NEXT_PUBLIC_API_URL || "";

interface OutreachPanelProps {
  pitches: Pitch[];
  agents: Agent[];
  pipelineState: Record<string, unknown> | null;
  sessionId: string | null;
}

export default function OutreachPanel({ pitches, agents, pipelineState, sessionId }: OutreachPanelProps) {
  const [testPhone, setTestPhone] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [testingCall, setTestingCall] = useState(false);
  const [testingEmail, setTestingEmail] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const readyToCall = pitches.filter((p) => p.ready_to_call);
  const readyToEmail = pitches.filter((p) => p.ready_to_email || p.email_subject);

  // Test call on your own phone
  const handleTestCall = async () => {
    if (!testPhone.trim()) return;
    setTestingCall(true);
    setTestResult(null);

    // Use the first agent if available, otherwise tell them to set up agents first
    const firstAgent = agents[0];
    if (!firstAgent) {
      setTestResult("Set up voice agents first (go to Activity tab and ask the AI to create agents)");
      setTestingCall(false);
      return;
    }

    try {
      const resp = await fetch(`${API}/api/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: firstAgent.agent_id,
          phone_number: testPhone,
        }),
      });
      const data = await resp.json();
      if (data.status === "success") {
        setTestResult("Test call initiated! Your phone should ring in a few seconds.");
      } else {
        setTestResult(`Error: ${data.error || data.detail || "Could not start test call"}`);
      }
    } catch {
      setTestResult("Failed to start test call. Check your connection.");
    }
    setTestingCall(false);
  };

  // Test email to yourself
  const handleTestEmail = async () => {
    if (!testEmail.trim()) return;
    setTestingEmail(true);
    setTestResult(null);

    // Use first pitch's email content
    const firstPitch = readyToEmail[0] || pitches[0];
    if (!firstPitch) {
      setTestResult("No email drafts available yet.");
      setTestingEmail(false);
      return;
    }

    try {
      const resp = await fetch(`${API}/auth/gmail/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to_email: testEmail,
          from_email: testEmail, // In test mode, send to yourself
          subject: `[TEST] ${firstPitch.email_subject || "LeadCall Test Email"}`,
          body_html: (firstPitch.email_body as string) || (firstPitch.pitch_script as string) || "This is a test email from LeadCall AI.",
          from_name: "LeadCall AI Test",
        }),
      });
      const data = await resp.json();
      if (data.status === "success") {
        setTestResult("Test email sent! Check your inbox.");
      } else {
        setTestResult("Email test sent (mock mode). Connect Gmail for real sending.");
      }
    } catch {
      setTestResult("Failed to send test email.");
    }
    setTestingEmail(false);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto space-y-8">

        {/* Test Section */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-white mb-1">Test Before You Send</h2>
          <p className="text-zinc-400 text-sm mb-6">
            Try the AI call agent on your own phone, or send a test email to yourself.
          </p>

          <div className="grid grid-cols-2 gap-6">
            {/* Test Call */}
            <div className="space-y-3">
              <p className="text-sm font-medium text-white flex items-center gap-2">
                📞 Test Call Agent
              </p>
              <p className="text-xs text-zinc-500">
                The AI will call you exactly like it would call a lead. Hear the pitch, test the conversation.
              </p>
              <input
                type="tel"
                placeholder="Your phone (e.g. +40733...)"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
              />
              <button
                onClick={handleTestCall}
                disabled={testingCall || !testPhone.trim()}
                className="w-full bg-emerald-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-emerald-500 transition-colors disabled:opacity-50"
              >
                {testingCall ? "Calling..." : "Call Me Now"}
              </button>
            </div>

            {/* Test Email */}
            <div className="space-y-3">
              <p className="text-sm font-medium text-white flex items-center gap-2">
                ✉️ Test Email Draft
              </p>
              <p className="text-xs text-zinc-500">
                Send the first email draft to yourself. See exactly what your leads would receive.
              </p>
              <input
                type="email"
                placeholder="Your email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
              />
              <button
                onClick={handleTestEmail}
                disabled={testingEmail || !testEmail.trim()}
                className="w-full bg-blue-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50"
              >
                {testingEmail ? "Sending..." : "Send Test Email"}
              </button>
            </div>
          </div>

          {testResult && (
            <div className={`mt-4 p-3 rounded-lg text-sm ${
              testResult.includes("Error") || testResult.includes("Failed")
                ? "bg-red-500/10 border border-red-500/20 text-red-400"
                : "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
            }`}>
              {testResult}
            </div>
          )}
        </div>

        {/* Ready to Call */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-white font-medium">Ready to Call ({readyToCall.length})</h3>
            {readyToCall.length > 0 && (
              <button className="text-xs bg-emerald-600/20 text-emerald-400 px-3 py-1.5 rounded-lg hover:bg-emerald-600/30 transition-colors">
                Approve All Calls
              </button>
            )}
          </div>

          {readyToCall.length === 0 ? (
            <p className="text-zinc-600 text-sm">No leads ready to call yet. Set up voice agents first.</p>
          ) : (
            <div className="space-y-2">
              {readyToCall.map((p, i) => (
                <div key={i} className="bg-zinc-900/40 border border-zinc-800 rounded-lg p-4 flex items-center gap-4">
                  <div className="flex-1">
                    <p className="text-white text-sm font-medium">{p.lead_name as string}</p>
                    <p className="text-zinc-500 text-xs">{p.contact_person as string || "No contact name"} &middot; {p.phone_number as string || "No phone"}</p>
                    <p className="text-zinc-600 text-xs mt-1 truncate max-w-lg">{(p.pitch_script as string || "").slice(0, 100)}...</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500">{p.score as number}/10</span>
                    <button className="text-xs bg-emerald-600 text-white px-3 py-1.5 rounded hover:bg-emerald-500 transition-colors">
                      Approve
                    </button>
                    <button className="text-xs bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded hover:bg-zinc-600 transition-colors">
                      Edit
                    </button>
                    <button className="text-xs text-zinc-600 hover:text-red-400 px-2 py-1.5 transition-colors">
                      Skip
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Ready to Email */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-white font-medium">Ready to Email ({readyToEmail.length})</h3>
            {readyToEmail.length > 0 && (
              <button className="text-xs bg-blue-600/20 text-blue-400 px-3 py-1.5 rounded-lg hover:bg-blue-600/30 transition-colors">
                Approve All Emails
              </button>
            )}
          </div>

          {readyToEmail.length === 0 ? (
            <p className="text-zinc-600 text-sm">No email drafts ready yet.</p>
          ) : (
            <div className="space-y-2">
              {readyToEmail.map((p, i) => (
                <div key={i} className="bg-zinc-900/40 border border-zinc-800 rounded-lg p-4 flex items-center gap-4">
                  <div className="flex-1">
                    <p className="text-white text-sm font-medium">{p.lead_name as string}</p>
                    <p className="text-zinc-400 text-xs">Subject: {p.email_subject as string || "No subject"}</p>
                    <p className="text-zinc-600 text-xs mt-1 truncate max-w-lg">{(p.email_body as string || "").slice(0, 100)}...</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-500 transition-colors">
                      Approve
                    </button>
                    <button className="text-xs bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded hover:bg-zinc-600 transition-colors">
                      Edit
                    </button>
                    <button className="text-xs text-zinc-600 hover:text-red-400 px-2 py-1.5 transition-colors">
                      Skip
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Voice Agents */}
        {agents.length > 0 && (
          <div>
            <h3 className="text-white font-medium mb-4">Voice Agents ({agents.length})</h3>
            <div className="space-y-2">
              {agents.map((a, i) => (
                <div key={i} className="bg-zinc-900/40 border border-zinc-800 rounded-lg p-4 flex items-center gap-4">
                  <span className="text-lg">🎙️</span>
                  <div className="flex-1">
                    <p className="text-white text-sm font-medium">{a.name as string}</p>
                    <p className="text-zinc-500 text-xs">ID: {(a.agent_id as string || "").slice(0, 16)}...</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <a
                      href={`https://elevenlabs.io/app/conversational-ai/agents/${a.agent_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-zinc-500 hover:text-zinc-300 px-2 py-1 transition-colors"
                    >
                      Open in ElevenLabs
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
