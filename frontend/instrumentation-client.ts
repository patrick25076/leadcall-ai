// ─── PostHog (User Analytics — EU Cloud) ──────────────────────────────────
import posthog from "posthog-js";

posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
  api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  defaults: "2026-01-30",
});

// ─── Sentry (Error Tracking — EU Region) ──────────────────────────────────
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "https://93d6ad94a9c96957eb3461ab9f3ef6c5@o4511128619319296.ingest.de.sentry.io/4511128622137424",
  tracesSampleRate: 1,
  enableLogs: true,
  sendDefaultPii: true,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
