import { logger, task, metadata } from "@trigger.dev/sdk/v3";

const API_URL = process.env.GRAI_API_URL || "https://grai.run";
const API_KEY = process.env.GRAI_INTERNAL_KEY || "";

async function apiCall(path: string, method = "GET", body?: Record<string, unknown>) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;

  const resp = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API ${method} ${path} failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

/**
 * Onboard Campaign — runs after the pipeline completes.
 *
 * Steps:
 * 1. Build knowledge base from crawled website data
 * 2. Create ElevenLabs agent with KB attached
 * 3. Set up dynamic variables
 *
 * Triggered from the backend after pipeline_complete event.
 */
export const onboardCampaign = task({
  id: "onboard-campaign",
  maxDuration: 600, // 10 min max (scraping + KB upload can be slow)
  retry: { maxAttempts: 2 },
  run: async (payload: {
    campaignId: number;
    userId: string;
    agentId?: string;
  }) => {
    const { campaignId, userId } = payload;
    logger.info("Starting campaign onboarding", { campaignId, userId });
    metadata.set("campaignId", campaignId);

    // Step 1: Get campaign state
    metadata.set("step", "loading_state");
    const state = await apiCall(`/api/campaigns/${campaignId}/state`);
    logger.info("Campaign state loaded", {
      business: state.business_analysis?.business_name,
      leads: state.scored_leads?.length || 0,
      pitches: state.judged_pitches?.length || 0,
    });

    // Step 2: Build KB if not already built
    metadata.set("step", "building_kb");
    if (!state.el_kb_id) {
      logger.info("Building knowledge base...");
      // KB is built automatically via save_business_analysis hook,
      // but we can trigger it explicitly via chat if needed
      const chatResp = await apiCall("/api/chat", "POST", {
        message: `[SYSTEM] For campaign ${campaignId}: call build_campaign_kb to create the knowledge base from the website crawl data.`,
        session_id: `trigger_${campaignId}_${Date.now()}`,
      });
      logger.info("KB build triggered via chat", { response: "ok" });
    } else {
      logger.info("KB already exists", { kbId: state.el_kb_id });
    }

    // Step 3: Check if agent exists
    metadata.set("step", "checking_agents");
    const agents = state.elevenlabs_agents || [];
    if (agents.length > 0) {
      logger.info("Agents already created", { count: agents.length });
    } else {
      logger.info("No agents yet — will be created when user configures voice settings");
    }

    metadata.set("step", "complete");
    return {
      campaignId,
      kbId: state.el_kb_id || "pending",
      agentsCreated: agents.length,
      leadsReady: (state.judged_pitches || []).filter(
        (p: Record<string, unknown>) => p.ready_to_call
      ).length,
    };
  },
});
