import { logger, task, metadata, wait } from "@trigger.dev/sdk/v3";

const API_URL = process.env.GRAI_API_URL || "https://grai.run";
const EL_API_KEY = process.env.ELEVENLABS_API_KEY || "";

/**
 * Batch Outreach — submit and monitor a batch of outbound calls.
 *
 * Steps:
 * 1. Submit batch to ElevenLabs
 * 2. Poll for completion
 * 3. Fetch results and update DB
 */
export const batchOutreach = task({
  id: "batch-outreach",
  maxDuration: 3600, // 1 hour max (batch calls can take time)
  retry: { maxAttempts: 1 },
  run: async (payload: {
    campaignId: number;
    agentId: string;
    callName: string;
    recipients: Array<{
      phone_number: string;
      dynamic_variables?: Record<string, string>;
    }>;
    concurrencyLimit?: number;
    scheduledTimeUnix?: number;
    timezone?: string;
  }) => {
    const {
      campaignId,
      agentId,
      callName,
      recipients,
      concurrencyLimit = 3,
      scheduledTimeUnix,
      timezone = "Europe/Bucharest",
    } = payload;

    logger.info("Submitting batch outreach", {
      campaignId,
      agentId,
      recipients: recipients.length,
    });
    metadata.set("campaignId", campaignId);
    metadata.set("totalRecipients", recipients.length);

    // Step 1: Submit batch
    metadata.set("step", "submitting");
    const phoneNumberId = process.env.ELEVENLABS_PHONE_NUMBER_ID || "";
    if (!phoneNumberId) {
      throw new Error("ELEVENLABS_PHONE_NUMBER_ID not configured");
    }

    const batchPayload: Record<string, unknown> = {
      call_name: callName,
      agent_id: agentId,
      agent_phone_number_id: phoneNumberId,
      recipients: recipients.map((r) => ({
        phone_number: r.phone_number,
        ...(r.dynamic_variables
          ? {
              conversation_initiation_client_data: {
                dynamic_variables: r.dynamic_variables,
              },
            }
          : {}),
      })),
      target_concurrency_limit: Math.min(Math.max(concurrencyLimit, 1), 10),
      timezone,
    };
    if (scheduledTimeUnix) {
      batchPayload.scheduled_time_unix = scheduledTimeUnix;
    }

    const submitResp = await fetch(
      "https://api.elevenlabs.io/v1/convai/batch-calling/submit",
      {
        method: "POST",
        headers: {
          "xi-api-key": EL_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batchPayload),
      }
    );
    if (!submitResp.ok) {
      const errText = await submitResp.text();
      throw new Error(`Batch submit failed: ${submitResp.status} ${errText}`);
    }
    const batchData = (await submitResp.json()) as Record<string, unknown>;
    const batchId = batchData.id as string;
    logger.info("Batch submitted", { batchId, status: batchData.status });
    metadata.set("batchId", batchId);
    metadata.set("step", "polling");

    // Step 2: Poll for completion
    let status = batchData.status as string;
    let pollCount = 0;
    const maxPolls = 120; // 120 * 30s = 1 hour max

    while (status !== "completed" && status !== "failed" && status !== "cancelled") {
      pollCount++;
      if (pollCount > maxPolls) {
        logger.warn("Max poll count reached, stopping");
        break;
      }

      await wait.for({ seconds: 30 });

      const statusResp = await fetch(
        `https://api.elevenlabs.io/v1/convai/batch-calling/${batchId}`,
        { headers: { "xi-api-key": EL_API_KEY } }
      );
      if (!statusResp.ok) continue;

      const statusData = (await statusResp.json()) as Record<string, unknown>;
      status = statusData.status as string;
      const dispatched = statusData.total_calls_dispatched as number;
      const finished = statusData.total_calls_finished as number;
      const scheduled = statusData.total_calls_scheduled as number;

      metadata.set("status", status);
      metadata.set("progress", `${finished}/${scheduled}`);
      logger.info("Batch progress", { status, dispatched, finished, scheduled });
    }

    // Step 3: Return results
    metadata.set("step", "complete");
    return {
      batchId,
      status,
      campaignId,
    };
  },
});
