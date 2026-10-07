import { CREATIVE_MAX_BATCH_SIZE, creativeBatchResponseSchema, MUSIC_MODES, type CreativeBatchResponse } from "@postdom/core";
import { z } from "zod";

import { PostdomApiError, defineTool, type PostdomMcpToolDefinition } from "./registry";

/**
 * `generate_content`: an agent asks Postdom to write a batch of
 * drafts from the workspace's Brand Brain, or reads a batch it started.
 *
 * Registered once, here, through the same registry every other tool uses. Not offered to
 * Postdom Chat (no `nativeChat` metadata: the chat's tool budget does not grow), and not on the
 * public agent menu (`POSTDOM_MCP_TOOLS`) until Autopilot launches: `createPostdomMcpServer`
 * registers it only when asked to (`{ autopilot: true }`, or `POSTDOM_MCP_AUTOPILOT=1` for the
 * stdio CLI), so the menu postdom.com documents and counts is unchanged.
 */

function compact(batch: CreativeBatchResponse) {
  return {
    batch_id: batch.id,
    status: batch.status,
    requested: batch.requested_count,
    failure_reason: batch.failure_reason,
    items: batch.items.map((item) => ({
      position: item.position,
      status: item.status,
      replaces: item.replaces,
      format_id: item.spec?.format_id ?? null,
      topic: item.spec?.topic ?? null,
      hook: item.spec?.hook ?? null,
      cta: item.spec?.cta ?? null,
      captions: item.spec?.caption ?? null,
      sources: item.spec?.sources ?? [],
      media_ids: item.media.map((media) => media.media_id),
      preview_urls: item.media.map((media) => media.preview_url),
      // The API answers a fixed sentence for every error; an agent gets it once, and
      // the failure codes (never internal text) to act on.
      errors: [...new Set(item.errors.map((error) => error.message))].slice(0, 3),
      error_codes: [...new Set(item.errors.map((error) => error.code))].slice(0, 5)
    }))
  };
}

const DONE = new Set(["ready", "partial", "failed"]);

export const POSTDOM_AUTOPILOT_TOOLS: readonly PostdomMcpToolDefinition[] = [
  defineTool({
    name: "generate_content",
    title: "Generate content",
    description:
      "Write a batch of branded carousel drafts from the workspace's Brand Brain (read from its website): topic, hook, slides rendered on the brand kit, CTA, captions per platform, each claim tied to a source page. Drafts wait for human review; nothing is published. Omit batch_id to start a batch (one at a time; it takes a few minutes); pass batch_id to read its progress and drafts.",
    inputSchema: {
      batch_id: z.uuid().optional(),
      count: z.number().int().min(1).max(CREATIVE_MAX_BATCH_SIZE).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (client, { batch_id, count }) => {
      if (batch_id) {
        const batch = await client.getContentBatch(batch_id);
        return { ...compact(batch), next: DONE.has(batch.status) ? "Drafts with status ready_for_review are waiting for a person to approve them in Postdom." : "Still writing: call generate_content again with this batch_id in a minute." };
      }
      try {
        const batch = await client.generateContent({ count });
        return { ...compact(batch), next: "Writing has started: call generate_content with this batch_id in a minute or two." };
      } catch (error) {
        const running = error instanceof PostdomApiError && error.code === "creative_batch_in_progress" ? creativeBatchResponseSchema.safeParse(error.problem?.batch) : null;
        if (running?.success) return { ...compact(running.data), next: "A batch is already being written: call generate_content with this batch_id to follow it." };
        throw error;
      }
    }
  }),
  // Who adds the music per account, and where each handed-off video stands.
  defineTool({
    name: "account_music",
    title: "Account music",
    description:
      "Read or set who adds the music on each connected account. 'postdom' (the default): Postdom adds music and posts on schedule. 'trending' (TikTok only): at post time the video goes silent to the creator's TikTok inbox, where the person adds a trending sound and posts it. Omit account_id to read every account, the autopilot holds (3 inbox videos waiting) and, with post_ids, each post's inbox or 'Post it myself' state. Pass account_id and music to change one account.",
    inputSchema: {
      account_id: z.string().min(1).max(200).optional(),
      music: z.enum(MUSIC_MODES).optional(),
      post_ids: z.array(z.uuid()).max(100).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (client, { account_id, music, post_ids }) => {
      if (account_id && music) return { changed: await client.setAccountMusic(account_id, music) };
      const read = await client.getMusic();
      return { ...read, ...(post_ids?.length ? { handoffs: await client.getHandoffs(post_ids) } : {}) };
    }
  })
];

export const POSTDOM_AUTOPILOT_TOOL_NAMES: readonly string[] = POSTDOM_AUTOPILOT_TOOLS.map((tool) => tool.name);
