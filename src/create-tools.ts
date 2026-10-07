import { z } from "zod";
import { defineTool, nativeChat, type PostdomMcpToolDefinition } from "./registry";

/**
 * One chat that creates.
 *
 * One chat. The chat that answers about the workspace also makes posts, in the
 * native style (real photos with the brand's own text boxes, and videos of them over clips), right
 * inside the conversation. `create_posts` is how the chat's model asks for that, and all it does
 * is ask: it calls no API route and spends nothing. Its answer is recorded on the turn, and the
 * app draws a create card for it under the reply. The card starts the work through the person's
 * own dashboard credential (`POST /v1/dashboard/create-chat/in-chat`, keyed by this tool step so
 * the card opens the same work however often it is drawn), and every pick, approve and schedule
 * after that is the person's click on the card, decided by the API without the model.
 *
 * So the model can never claim a post exists: it has only asked for one. Chat-only, like the
 * rules tools: an agent over MCP makes slideshows with `create_slideshow` and has no card.
 */

export const CREATE_POSTS_DETAIL = "A create card under your reply makes them; the person picks, changes and approves there.";

export const POSTDOM_CHAT_CREATE_TOOLS: readonly PostdomMcpToolDefinition[] = [
  defineTool({
    name: "create_posts",
    title: "Make posts",
    description: "Make posts in the brand: slideshow (count 1-5, default 3) or video. topic in their words. A card under your reply makes them: say in one sentence they're being made below, never that they're made or posted.",
    inputSchema: {
      format: z.enum(["slideshow", "video"]),
      topic: z.string().trim().min(1).max(300),
      count: z.number().int().min(1).max(5).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(20),
    run: async (_client, { format, topic, count }) => ({
      status: "opened",
      format,
      topic,
      count: format === "video" ? 1 : count ?? 3,
      next: CREATE_POSTS_DETAIL
    })
  })
];

export const POSTDOM_CHAT_CREATE_TOOL_NAMES: readonly string[] = POSTDOM_CHAT_CREATE_TOOLS.map((tool) => tool.name);
