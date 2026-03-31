import { logger, task, metadata, schedules } from "@trigger.dev/sdk/v3";

const API_URL = process.env.GRAI_API_URL || "https://grai.run";
const EL_API_KEY = process.env.ELEVENLABS_API_KEY || "";

/**
 * KB Refresh — re-scrape a website and update the knowledge base.
 *
 * Use when a client says "our prices changed" or on a schedule.
 * Deletes old docs from KB and re-uploads fresh content.
 */
export const kbRefresh = task({
  id: "kb-refresh",
  maxDuration: 300, // 5 min
  retry: { maxAttempts: 2 },
  run: async (payload: {
    campaignId: number;
    kbId: string;
    websiteUrl: string;
  }) => {
    const { campaignId, kbId, websiteUrl } = payload;
    logger.info("Refreshing KB", { campaignId, kbId, websiteUrl });
    metadata.set("campaignId", campaignId);
    metadata.set("step", "fetching_docs");

    // Step 1: Get existing doc IDs from our backend
    const stateResp = await fetch(`${API_URL}/api/campaigns/${campaignId}/state`, {
      headers: { "Content-Type": "application/json" },
    });
    const state = stateResp.ok ? (await stateResp.json()) as Record<string, unknown> : {};

    // Step 2: Delete old docs from ElevenLabs (new flat API)
    metadata.set("step", "deleting_old_docs");
    const docsResp = await fetch(
      `https://api.elevenlabs.io/v1/convai/knowledge-base`,
      { headers: { "xi-api-key": EL_API_KEY } }
    );

    if (docsResp.ok) {
      const docsData = (await docsResp.json()) as { documents?: Array<{ id: string; name: string }> };
      const allDocs = docsData.documents || [];

      for (const doc of allDocs) {
        try {
          await fetch(
            `https://api.elevenlabs.io/v1/convai/knowledge-base/${doc.id}?force=true`,
            { method: "DELETE", headers: { "xi-api-key": EL_API_KEY } }
          );
          logger.info("Deleted old doc", { docId: doc.id, name: doc.name });
        } catch (e) {
          logger.warn("Failed to delete doc", { docId: doc.id, error: String(e) });
        }
      }
    }

    // Step 3: Trigger re-build via the backend chat API
    metadata.set("step", "rebuilding");
    const chatResp = await fetch(`${API_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `[SYSTEM] Re-crawl ${websiteUrl} and rebuild the knowledge base for campaign ${campaignId}. Use crawl_website then build_campaign_kb.`,
        session_id: `kb_refresh_${campaignId}_${Date.now()}`,
      }),
    });

    if (!chatResp.ok) {
      throw new Error(`Chat API failed: ${chatResp.status}`);
    }

    metadata.set("step", "complete");
    logger.info("KB refresh complete", { campaignId, kbId });

    return { campaignId, kbId, status: "refreshed" };
  },
});

/**
 * Scheduled KB refresh — runs weekly for all active campaigns.
 * Keeps knowledge bases up to date with latest website content.
 */
export const scheduledKbRefresh = schedules.task({
  id: "scheduled-kb-refresh",
  // Runs every Monday at 3 AM Bucharest time
  cron: "0 3 * * 1",
  timezone: "Europe/Bucharest",
  run: async () => {
    logger.info("Running scheduled KB refresh for all campaigns");

    // Fetch all campaigns with KBs
    const resp = await fetch(`${API_URL}/api/campaigns`, {
      headers: { "Content-Type": "application/json" },
    });
    if (!resp.ok) {
      logger.error("Failed to fetch campaigns");
      return;
    }

    const data = (await resp.json()) as { campaigns?: Array<Record<string, unknown>> };
    const campaigns = data.campaigns || [];

    let refreshed = 0;
    for (const campaign of campaigns) {
      const kbId = campaign.el_kb_id as string;
      const url = campaign.website_url as string;
      const id = campaign.id as number;

      if (kbId && url) {
        // Trigger individual KB refresh
        await kbRefresh.trigger({
          campaignId: id,
          kbId,
          websiteUrl: url,
        });
        refreshed++;
      }
    }

    logger.info("Scheduled refresh triggered", { total: refreshed });
    return { campaignsRefreshed: refreshed };
  },
});
