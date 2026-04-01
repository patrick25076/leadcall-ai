"use client";

export const dynamic = "force-dynamic";

import { useState, useEffect, useRef, useCallback } from "react";
import OnboardingWizard, { type OnboardingConfig } from "@/components/OnboardingWizard";
import Dashboard from "@/components/Dashboard";
import CampaignList from "@/components/CampaignList";
import { supabase } from "@/lib/supabase";
import { apiFetch } from "@/lib/api";

type View = "loading" | "onboarding" | "campaigns" | "dashboard";

export default function Home() {
  const [view, setView] = useState<View>("loading");
  const [activeCampaignId, setActiveCampaignId] = useState<number | null>(null);
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const viewRef = useRef<View>("loading");

  // Keep ref in sync so the auth listener can read current view
  useEffect(() => { viewRef.current = view; }, [view]);

  useEffect(() => {
    let mounted = true;
    let checkingCampaigns = false;

    async function checkCampaigns(): Promise<boolean> {
      if (checkingCampaigns) return false;
      checkingCampaigns = true;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const resp = await apiFetch("/api/campaigns", { signal: controller.signal });
        clearTimeout(timeout);
        if (resp.ok) {
          const data = await resp.json();
          const campaigns = data.campaigns || data || [];
          if (Array.isArray(campaigns) && campaigns.length > 0) {
            if (mounted) setView("campaigns");
            return true;
          }
        }
      } catch { /* timeout or network error — fall through */ }
      finally { checkingCampaigns = false; }
      return false;
    }

    // Single auth handler — use onAuthStateChange exclusively (fires INITIAL_SESSION on subscribe)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (!mounted) return;

        // Sign-out: always reset
        if (event === "SIGNED_OUT") {
          setUser(null);
          setView("onboarding");
          setActiveCampaignId(null);
          return;
        }

        // Token refresh: session still valid, don't change views
        if (event === "TOKEN_REFRESHED") return;

        // Initial session: first load or OAuth redirect — this is the only initial routing
        if (event === "INITIAL_SESSION") {
          if (session?.user) {
            setUser({ id: session.user.id, email: session.user.email || "" });
            const hasCampaigns = await checkCampaigns();
            if (mounted && !hasCampaigns) setView("onboarding");
          } else {
            setView("onboarding");
          }
          return;
        }

        // SIGNED_IN: user just logged in (from OnboardingWizard)
        // Update user state but let OnboardingWizard handle post-login routing
        if (event === "SIGNED_IN" && session?.user) {
          setUser({ id: session.user.id, email: session.user.email || "" });
          // Only check campaigns if somehow still on loading screen
          if (viewRef.current === "loading") {
            const hasCampaigns = await checkCampaigns();
            if (mounted && !hasCampaigns) setView("onboarding");
          }
        }
      }
    );

    // Failsafe: if still loading after 5s, go to onboarding
    const failsafe = setTimeout(() => {
      if (mounted && viewRef.current === "loading") setView("onboarding");
    }, 5000);

    return () => {
      mounted = false;
      subscription.unsubscribe();
      clearTimeout(failsafe);
    };
  }, []);

  const [autoAnalyzeUrl, setAutoAnalyzeUrl] = useState<string | null>(null);

  const handleOnboardingComplete = (config: OnboardingConfig) => {
    try {
      localStorage.setItem("leadcall_url", JSON.stringify(config.websiteUrl));
      localStorage.setItem("leadcall_onboarding_config", JSON.stringify(config));
    } catch { /* ignore storage errors */ }
    setAutoAnalyzeUrl(config.websiteUrl); // Tell Dashboard to auto-start
    setView("dashboard");
    setActiveCampaignId(null);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    localStorage.clear();
    // SIGNED_OUT event handler will reset view and user state
  };

  const handleSelectCampaign = (id: number) => {
    setActiveCampaignId(id);
    setView("dashboard");
  };

  const handleNewCampaign = () => {
    // Go to onboarding wizard but skip auth step (already authenticated)
    setView("onboarding");
  };

  const handleHasCampaigns = useCallback(() => {
    setView("campaigns");
  }, []);

  const handleBackToCampaigns = () => {
    setActiveCampaignId(null);
    setView("campaigns");
  };

  if (view === "loading") {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <div className="text-zinc-500">Loading...</div>
      </div>
    );
  }

  if (view === "onboarding") {
    return (
      <OnboardingWizard
        initialUser={user}
        onComplete={handleOnboardingComplete}
        onHasCampaigns={handleHasCampaigns}
      />
    );
  }

  if (view === "campaigns") {
    return (
      <CampaignList
        onSelectCampaign={handleSelectCampaign}
        onNewCampaign={handleNewCampaign}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <Dashboard
      onLogout={handleLogout}
      campaignId={activeCampaignId ?? undefined}
      autoAnalyzeUrl={autoAnalyzeUrl ?? undefined}
      onBack={handleBackToCampaigns}
    />
  );
}
