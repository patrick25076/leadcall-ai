/**
 * GRAI Analytics — PostHog event helpers.
 *
 * PostHog is initialized in instrumentation-client.ts.
 * Import posthog directly anywhere and call methods.
 * These helpers provide typed event names for consistency.
 */

import posthog from "posthog-js";

export function identifyUser(userId: string, properties?: Record<string, unknown>) {
  posthog.identify(userId, properties);
}

export function resetAnalytics() {
  posthog.reset();
}

// ─── Typed Event Helpers ──────────────────────────────────────────────────

export const analytics = {
  // Onboarding
  onboardingStarted: () => posthog.capture("onboarding_started"),
  onboardingStepCompleted: (step: number, stepName: string) =>
    posthog.capture("onboarding_step_completed", { step, step_name: stepName }),
  onboardingCompleted: (config: Record<string, unknown>) =>
    posthog.capture("onboarding_completed", config),

  // Analysis
  analysisStarted: (url: string) => posthog.capture("analysis_started", { url }),
  analysisCompleted: (leadsFound: number, duration: number) =>
    posthog.capture("analysis_completed", { leads_found: leadsFound, duration_seconds: duration }),

  // Leads
  leadViewed: (leadName: string, grade: string) =>
    posthog.capture("lead_viewed", { lead_name: leadName, grade }),
  leadApproved: (leadName: string) => posthog.capture("lead_approved", { lead_name: leadName }),
  leadRejected: (leadName: string) => posthog.capture("lead_rejected", { lead_name: leadName }),

  // Outreach
  callTestInitiated: () => posthog.capture("call_test_initiated"),
  callApproved: (count: number) => posthog.capture("call_approved", { count }),
  emailTestSent: () => posthog.capture("email_test_sent"),
  emailApproved: (count: number) => posthog.capture("email_approved", { count }),
  outreachLaunched: (calls: number, emails: number) =>
    posthog.capture("outreach_launched", { calls, emails }),

  // Voice
  voiceAgentCreated: (count: number) => posthog.capture("voice_agent_created", { count }),
  voiceAgentTested: () => posthog.capture("voice_agent_tested"),

  // Navigation
  tabSwitched: (tab: string) => posthog.capture("tab_switched", { tab }),
  chatMessageSent: () => posthog.capture("chat_message_sent"),

  // Errors
  errorShown: (error: string, context: string) =>
    posthog.capture("error_shown", { error, context }),
};
