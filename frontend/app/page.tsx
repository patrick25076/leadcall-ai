"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import OnboardingWizard, { type OnboardingConfig } from "@/components/OnboardingWizard";
import Dashboard from "@/components/Dashboard";
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

export default function Home() {
  const [onboarded, setOnboarded] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        const saved = loadFromStorage<boolean>("onboarded", false);
        if (saved) setOnboarded(true);
      }
      setCheckingAuth(false);
    });
  }, []);

  const handleOnboardingComplete = (config: OnboardingConfig) => {
    saveToStorage("url", config.websiteUrl);
    saveToStorage("onboarded", true);
    saveToStorage("onboarding_config", config);
    setOnboarded(true);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    localStorage.clear();
    setOnboarded(false);
  };

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <div className="text-zinc-500">Loading...</div>
      </div>
    );
  }

  if (!onboarded) {
    return <OnboardingWizard onComplete={handleOnboardingComplete} />;
  }

  return <Dashboard onLogout={handleLogout} />;
}
