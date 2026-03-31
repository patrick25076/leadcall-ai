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
  const viewRef = useRef<View>("loading");

  // Keep ref in sync so the auth listener can read current view
  useEffect(() => { viewRef.current = view; }, [view]);

  useEffect(() => {
    async function checkCampaigns(): Promise<boolean> {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const resp = await apiFetch("/api/campaigns", { signal: controller.signal });
        clearTimeout(timeout);
        if (resp.ok) {
          const data = await resp.json();
          const campaigns = data.campaigns || data || [];
          if (Array.isArray(campaigns) && campaigns.length > 0) {
            setView("campaigns");
            return true;
          }
        }
      } catch { /* timeout or network error — fall through */ }
      return false;
    }

    // Initial session check
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session?.user) {
        const hasCampaigns = await checkCampaigns();
        if (!hasCampaigns) setView("onboarding");
      } else {
        setView("onboarding");
      }
    }).catch(() => {
      setView("onboarding");
    });

    // Failsafe: if still loading after 10s, go to onboarding
    const failsafe = setTimeout(() => {
      if (viewRef.current === "loading") setView("onboarding");
    }, 10000);

    // Listen for auth state changes (handles OAuth redirects, token refresh, delayed session restore)
    // Only act when user is still on loading/onboarding — don't disrupt dashboard/campaigns views
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        const current = viewRef.current;
        if (current !== "loading" && current !== "onboarding") return;
        if (session?.user) {
          const hasCampaigns = await checkCampaigns();
          if (!hasCampaigns) setView("onboarding");
        }
      }
    );

    return () => {
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
    setView("onboarding");
    setActiveCampaignId(null);
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
