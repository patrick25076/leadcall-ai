"use client";

export const dynamic = "force-dynamic";

import { useState, useCallback, useEffect } from "react";
import OnboardingWizard, { type OnboardingConfig } from "@/components/OnboardingWizard";
import Dashboard from "@/components/Dashboard";
import CampaignList from "@/components/CampaignList";
import { supabase } from "@/lib/supabase";

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

type View = "loading" | "onboarding" | "campaigns" | "dashboard";

export default function Home() {
  const [view, setView] = useState<View>("loading");
  const [activeCampaignId, setActiveCampaignId] = useState<number | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        const onboarded = loadFromStorage<boolean>("onboarded", false);
        if (onboarded) {
          setView("campaigns");
        } else {
          setView("onboarding");
        }
      } else {
        setView("onboarding");
      }
    });
  }, []);

  const handleOnboardingComplete = (config: OnboardingConfig) => {
    saveToStorage("url", config.websiteUrl);
    saveToStorage("onboarded", true);
    saveToStorage("onboarding_config", config);
    // Go to dashboard for the new campaign (will auto-start analysis)
    setView("dashboard");
    setActiveCampaignId(null); // null = new campaign, will use URL from storage
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
      onBack={handleBackToCampaigns}
    />
  );
}
