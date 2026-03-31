"use client";

export const dynamic = "force-dynamic";

import { useState, useEffect } from "react";
import OnboardingWizard, { type OnboardingConfig } from "@/components/OnboardingWizard";
import Dashboard from "@/components/Dashboard";
import CampaignList from "@/components/CampaignList";
import { supabase } from "@/lib/supabase";

const API = process.env.NEXT_PUBLIC_API_URL || "";

type View = "loading" | "onboarding" | "campaigns" | "dashboard";

export default function Home() {
  const [view, setView] = useState<View>("loading");
  const [activeCampaignId, setActiveCampaignId] = useState<number | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session?.user) {
        // Check backend for existing campaigns to determine new vs returning user
        try {
          const resp = await fetch(`${API}/api/campaigns`, {
            headers: {
              Authorization: `Bearer ${session.access_token}`,
            },
          });
          if (resp.ok) {
            const data = await resp.json();
            const campaigns = data.campaigns || data || [];
            if (Array.isArray(campaigns) && campaigns.length > 0) {
              setView("campaigns");
            } else {
              setView("onboarding");
            }
          } else {
            setView("onboarding");
          }
        } catch {
          setView("onboarding");
        }
      } else {
        setView("onboarding");
      }
    });
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
    return <OnboardingWizard onComplete={handleOnboardingComplete} />;
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
