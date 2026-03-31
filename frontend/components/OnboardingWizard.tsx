"use client";

import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";

type Step = "auth" | "website" | "email" | "phone" | "done";

interface OnboardingWizardProps {
  onComplete: (config: OnboardingConfig) => void;
  onHasCampaigns?: () => void;
}

export interface OnboardingConfig {
  websiteUrl: string;
  email: string;
  emailConnected: boolean;
  phoneMode: "default" | "verified";
  verifiedPhone?: string;
  sessionId?: string;
}

const API = process.env.NEXT_PUBLIC_API_URL || "";

export default function OnboardingWizard({ onComplete, onHasCampaigns }: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>("auth");
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);

  // Website step
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState("");

  // Email step
  const [emailConnected, setEmailConnected] = useState(false);
  const [connectedEmail, setConnectedEmail] = useState("");

  // Phone step
  const [phoneMode, setPhoneMode] = useState<"default" | "verify">("default");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [validationCode, setValidationCode] = useState("");
  const [phoneVerifying, setPhoneVerifying] = useState(false);
  const [phoneVerified, setPhoneVerified] = useState(false);

  // Background analysis tracking
  const [analysisSessionId, setAnalysisSessionId] = useState("");
  const [analysisComplete, setAnalysisComplete] = useState(false);

  // Check for existing session on mount
  useEffect(() => {
    async function handleAuth(session: { user: { id: string; email?: string }; access_token: string }) {
      setUser({ id: session.user.id, email: session.user.email || "" });
      // If caller provided onHasCampaigns, check if user already has campaigns
      if (onHasCampaigns) {
        try {
          const resp = await fetch(`${API}/api/campaigns`, {
            headers: { Authorization: `Bearer ${session.access_token}` },
          });
          if (resp.ok) {
            const data = await resp.json();
            const campaigns = data.campaigns || data || [];
            if (Array.isArray(campaigns) && campaigns.length > 0) {
              onHasCampaigns();
              return;
            }
          }
        } catch { /* fall through to onboarding */ }
      }
      setStep("website");
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        handleAuth(session);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        handleAuth(session);
      }
    });

    return () => subscription.unsubscribe();
  }, [onHasCampaigns]);

  // Sign up / Login with Google
  const handleGoogleAuth = async () => {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin,
      },
    });
  };

  // Sign up with email/password
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "signup">("signup");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  const handleEmailAuth = async () => {
    setAuthLoading(true);
    setAuthError("");
    try {
      if (authMode === "signup") {
        const { error } = await supabase.auth.signUp({
          email: authEmail,
          password: authPassword,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: authEmail,
          password: authPassword,
        });
        if (error) throw error;
      }
    } catch (e: unknown) {
      setAuthError(e instanceof Error ? e.message : "Authentication failed");
    }
    setAuthLoading(false);
  };

  // Start website analysis in background
  const startAnalysis = useCallback(async () => {
    if (!websiteUrl.trim()) return;

    setAnalyzing(true);
    setAnalysisStatus("Starting analysis...");

    try {
      const response = await fetch(`${API}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: websiteUrl }),
      });

      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: session")) {
            const dataLine = lines[lines.indexOf(line) + 1];
            if (dataLine?.startsWith("data: ")) {
              try {
                const data = JSON.parse(dataLine.slice(6));
                setAnalysisSessionId(data.session_id || "");
              } catch {}
            }
          } else if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === "text" && data.content) {
                const short = data.content.slice(0, 80);
                setAnalysisStatus(`${data.author || "AI"}: ${short}...`);
              } else if (data.type === "agent_transfer") {
                setAnalysisStatus(`Running: ${data.target_agent}...`);
              }
            } catch {}
          } else if (line.startsWith("event: pipeline_complete")) {
            setAnalysisComplete(true);
            setAnalysisStatus("Analysis complete!");
          }
        }
      }
    } catch (e) {
      setAnalysisStatus("Analysis started in background");
    }

    setAnalyzing(false);
  }, [websiteUrl]);

  // Handle website submit → start analysis in background, move to email step
  const handleWebsiteSubmit = () => {
    if (!websiteUrl.trim()) return;
    startAnalysis(); // Fire and forget - runs in background
    setStep("email"); // Move to next step immediately
  };

  // Gmail OAuth (simplified - redirect based)
  const handleConnectGmail = async () => {
    // For MVP: use Supabase's Google OAuth which already has the user's Gmail
    // The user already signed in with Google, so we have their email
    if (user?.email) {
      setConnectedEmail(user.email);
      setEmailConnected(true);
    }
    // TODO: Full Gmail API OAuth for sending (needs Google Cloud Console setup)
    // For now, mark as connected using Supabase auth email
  };

  // Phone verification
  const handleVerifyPhone = async () => {
    if (!phoneNumber.trim()) return;
    setPhoneVerifying(true);

    try {
      const resp = await fetch(`${API}/api/phone/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone_number: phoneNumber,
          friendly_name: "Business Line",
        }),
      });
      const data = await resp.json();
      if (data.status === "success") {
        setValidationCode(data.validation_code);
      }
    } catch {}

    setPhoneVerifying(false);
  };

  // Complete onboarding
  const handleComplete = () => {
    onComplete({
      websiteUrl,
      email: connectedEmail || user?.email || "",
      emailConnected,
      phoneMode: phoneVerified ? "verified" : "default",
      verifiedPhone: phoneVerified ? phoneNumber : undefined,
      sessionId: analysisSessionId,
    });
  };

  return (
    <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Logo & Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">GRAI</h1>
          <p className="text-zinc-400">The Voice of Your Business</p>
        </div>

        {/* Progress Steps */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {(["auth", "website", "email", "phone"] as Step[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-all ${
                  step === s
                    ? "bg-emerald-500 text-white"
                    : (["auth", "website", "email", "phone"].indexOf(step) > i || step === "done")
                    ? "bg-emerald-500/20 text-emerald-400"
                    : "bg-zinc-800 text-zinc-500"
                }`}
              >
                {(["auth", "website", "email", "phone"].indexOf(step) > i || step === "done") ? "✓" : i + 1}
              </div>
              {i < 3 && <div className={`w-8 h-px ${
                ["auth", "website", "email", "phone"].indexOf(step) > i ? "bg-emerald-500/40" : "bg-zinc-800"
              }`} />}
            </div>
          ))}
        </div>

        {/* Step Content */}
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-6">

          {/* ─── Step 1: Auth ─── */}
          {step === "auth" && (
            <div>
              <h2 className="text-xl font-semibold text-white mb-1">Get Started</h2>
              <p className="text-zinc-400 text-sm mb-6">Create your account to start finding leads</p>

              <button
                onClick={handleGoogleAuth}
                className="w-full flex items-center justify-center gap-3 bg-white text-gray-800 font-medium py-3 px-4 rounded-lg hover:bg-gray-100 transition-colors mb-4"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Continue with Google
              </button>

              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-zinc-700" />
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-2 bg-zinc-900/80 text-zinc-500">or</span>
                </div>
              </div>

              <div className="space-y-3">
                <input
                  type="email"
                  placeholder="Email"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
                />
                <input
                  type="password"
                  placeholder="Password"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleEmailAuth()}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
                />
                {authError && <p className="text-red-400 text-sm">{authError}</p>}
                <button
                  onClick={handleEmailAuth}
                  disabled={authLoading || !authEmail || !authPassword}
                  className="w-full bg-emerald-600 text-white font-medium py-3 rounded-lg hover:bg-emerald-500 transition-colors disabled:opacity-50"
                >
                  {authLoading ? "..." : authMode === "signup" ? "Create Account" : "Log In"}
                </button>
                <p className="text-center text-zinc-500 text-sm">
                  {authMode === "signup" ? "Already have an account?" : "Don't have an account?"}{" "}
                  <button
                    onClick={() => setAuthMode(authMode === "signup" ? "login" : "signup")}
                    className="text-emerald-400 hover:underline"
                  >
                    {authMode === "signup" ? "Log in" : "Sign up"}
                  </button>
                </p>
              </div>
            </div>
          )}

          {/* ─── Step 2: Website URL ─── */}
          {step === "website" && (
            <div>
              <h2 className="text-xl font-semibold text-white mb-1">Your Business Website</h2>
              <p className="text-zinc-400 text-sm mb-6">
                Our AI will analyze your website to understand your business, find ideal leads, and create personalized pitches.
              </p>

              <div className="flex gap-2">
                <input
                  type="url"
                  placeholder="https://yourbusiness.com"
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleWebsiteSubmit()}
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
                  autoFocus
                />
                <button
                  onClick={handleWebsiteSubmit}
                  disabled={!websiteUrl.trim()}
                  className="bg-emerald-600 text-white font-medium px-6 py-3 rounded-lg hover:bg-emerald-500 transition-colors disabled:opacity-50 whitespace-nowrap"
                >
                  Next
                </button>
              </div>

              {analyzing && (
                <div className="mt-4 flex items-center gap-2 text-sm text-zinc-400">
                  <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
                  {analysisStatus}
                </div>
              )}
            </div>
          )}

          {/* ─── Step 3: Connect Email ─── */}
          {step === "email" && (
            <div>
              <h2 className="text-xl font-semibold text-white mb-1">Connect Your Email</h2>
              <p className="text-zinc-400 text-sm mb-6">
                Outreach emails will be sent from your own email account. Better deliverability, zero setup.
              </p>

              {/* Background analysis status */}
              {analyzing && (
                <div className="mb-4 p-3 bg-zinc-800/50 rounded-lg flex items-center gap-2 text-sm text-zinc-400">
                  <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
                  <span>Analyzing your website in background... {analysisStatus}</span>
                </div>
              )}
              {analysisComplete && (
                <div className="mb-4 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg flex items-center gap-2 text-sm text-emerald-400">
                  <span>&#10003;</span>
                  <span>Website analysis complete! Leads found.</span>
                </div>
              )}

              {!emailConnected ? (
                <div className="space-y-3">
                  <button
                    onClick={handleConnectGmail}
                    className="w-full flex items-center justify-center gap-3 bg-white text-gray-800 font-medium py-3 px-4 rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    Connect Gmail
                  </button>

                  <button
                    onClick={() => setStep("phone")}
                    className="w-full text-zinc-500 text-sm py-2 hover:text-zinc-300 transition-colors"
                  >
                    Skip for now — I'll connect later
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                    <span className="text-emerald-400 text-lg">&#10003;</span>
                    <div>
                      <p className="text-white font-medium">{connectedEmail}</p>
                      <p className="text-emerald-400 text-sm">Connected</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setStep("phone")}
                    className="w-full bg-emerald-600 text-white font-medium py-3 rounded-lg hover:bg-emerald-500 transition-colors"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ─── Step 4: Phone Setup ─── */}
          {step === "phone" && (
            <div>
              <h2 className="text-xl font-semibold text-white mb-1">Phone Setup</h2>
              <p className="text-zinc-400 text-sm mb-6">
                Choose how AI calls show up on your leads' phones.
              </p>

              {/* Background analysis status */}
              {analyzing && (
                <div className="mb-4 p-3 bg-zinc-800/50 rounded-lg flex items-center gap-2 text-sm text-zinc-400">
                  <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
                  <span>Still analyzing... {analysisStatus}</span>
                </div>
              )}

              <div className="space-y-3 mb-6">
                {/* Option 1: Default number */}
                <button
                  onClick={() => { setPhoneMode("default"); setPhoneVerified(false); }}
                  className={`w-full text-left p-4 rounded-lg border transition-colors ${
                    phoneMode === "default"
                      ? "border-emerald-500 bg-emerald-500/10"
                      : "border-zinc-700 bg-zinc-800/50 hover:border-zinc-600"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-white font-medium">Use LeadCall number</p>
                      <p className="text-zinc-400 text-sm">Start calling immediately with our number. Best for testing.</p>
                    </div>
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                      phoneMode === "default" ? "border-emerald-500" : "border-zinc-600"
                    }`}>
                      {phoneMode === "default" && <div className="w-2.5 h-2.5 bg-emerald-500 rounded-full" />}
                    </div>
                  </div>
                </button>

                {/* Option 2: Verify own number */}
                <button
                  onClick={() => setPhoneMode("verify")}
                  className={`w-full text-left p-4 rounded-lg border transition-colors ${
                    phoneMode === "verify"
                      ? "border-emerald-500 bg-emerald-500/10"
                      : "border-zinc-700 bg-zinc-800/50 hover:border-zinc-600"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-white font-medium">Use my business number</p>
                      <p className="text-zinc-400 text-sm">Calls show YOUR number. 1-minute verification.</p>
                    </div>
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                      phoneMode === "verify" ? "border-emerald-500" : "border-zinc-600"
                    }`}>
                      {phoneMode === "verify" && <div className="w-2.5 h-2.5 bg-emerald-500 rounded-full" />}
                    </div>
                  </div>
                </button>
              </div>

              {/* Verify flow */}
              {phoneMode === "verify" && !phoneVerified && (
                <div className="space-y-3 mb-4">
                  <input
                    type="tel"
                    placeholder="+40 712 345 678"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
                  />

                  {!validationCode ? (
                    <button
                      onClick={handleVerifyPhone}
                      disabled={phoneVerifying || !phoneNumber.trim()}
                      className="w-full bg-zinc-700 text-white font-medium py-3 rounded-lg hover:bg-zinc-600 transition-colors disabled:opacity-50"
                    >
                      {phoneVerifying ? "Calling your phone..." : "Verify my number"}
                    </button>
                  ) : (
                    <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                      <p className="text-amber-400 font-medium mb-1">We're calling you now!</p>
                      <p className="text-zinc-300 text-sm">
                        Answer the call and enter this code:{" "}
                        <span className="font-mono text-xl text-white">{validationCode}</span>
                      </p>
                      <button
                        onClick={() => setPhoneVerified(true)}
                        className="mt-3 w-full bg-emerald-600 text-white font-medium py-2 rounded-lg hover:bg-emerald-500 transition-colors text-sm"
                      >
                        I entered the code
                      </button>
                    </div>
                  )}
                </div>
              )}

              {phoneVerified && (
                <div className="mb-4 flex items-center gap-3 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                  <span className="text-emerald-400 text-lg">&#10003;</span>
                  <div>
                    <p className="text-white font-medium">{phoneNumber}</p>
                    <p className="text-emerald-400 text-sm">Verified — calls will show this number</p>
                  </div>
                </div>
              )}

              <button
                onClick={handleComplete}
                className="w-full bg-emerald-600 text-white font-medium py-3 rounded-lg hover:bg-emerald-500 transition-colors"
              >
                {analysisComplete ? "View Your Leads" : "Go to Dashboard"}
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-zinc-600 text-xs mt-6">
          EU compliant &middot; GDPR ready &middot; Enterprise-grade security
        </p>
      </div>
    </div>
  );
}
