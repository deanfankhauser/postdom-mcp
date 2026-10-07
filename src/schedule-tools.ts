import { z } from "zod";
import {
  agentPostFeedStatusSchema,
  corePlatformSchema,
  scheduleChange,
  type ScheduleChange,
  type ScheduleChangeAction
} from "@postdom/core";
import type { PostdomClient } from "./index";
import { captionPreview, runUrl } from "./projection";
import {
  NATIVE_CHAT_OPAQUE,
  PostdomApiError,
  PostdomToolRefusal,
  chatRead,
  chatWrite,
  defineTool,
  nativeChat,
  type PostdomMcpToolDefinition
} from "./registry";

/**
 * Chat can cancel a scheduled post and move one to a new time.
 *
 * Two tools that write through the route the Schedule screen's own two
 * controls write through - `POST /v1/dashboard/posts/:id/resolve`, the same
 * compare-and-set on the version and the request hash the page sends - so
 * nothing here is a second way to change a schedule, and no business logic
 * about what a cancellation means lives in a tool layer. `cancel` sends the
 * page's `cancel_schedule`: the post returns to draft and nothing goes out,
 * which is what the page's "Cancel schedule" does and what its toast says.
 * Terminal rejection is deliberately not offered - it is the page's other,
 * separate control, it cannot be undone, and this ticket's scope is a
 * scheduled post.
 *
 * Human authority, deliberately. The resolve route is one `isHumanAuthorityRoute`
 * refuses an agent credential on, so these tools are not on the MCP menu an
 * agent key sees - a tool an agent could never call is the failure
 * `upload_media` was taken off the chat menu for. An agent that needs to stop
 * its own scheduled post has `POST /v1/posts/:id/cancel`, which is a different
 * route with a different actor and is not on this menu either.
 *
 * Every answer is the card `@postdom/core` defines (`scheduleChangeSchema`):
 * the post, when it was due, when it is due now, and - when nothing was saved -
 * why, in the API's own sentence. `after` is read back from the API after the
 * write, never assumed from the request.
 */

/** The post as `GET /v1/posts/:id` answers one, read with the fields a
 * schedule change needs and nothing dropped: a field the route adds tomorrow
 * must not take a cancellation down. */
const postSchema = z.looseObject({
  id: z.string().min(1),
  version: z.number().int().positive(),
  request_hash: z.string().min(1),
  status: z.string().min(1),
  caption: z.string().nullable().optional(),
  scheduled_for: z.string().nullable().optional(),
  targets: z
    .array(z.looseObject({ platform: z.string(), handle: z.string().nullable().optional() }))
    .optional()
});
type PostRecord = z.infer<typeof postSchema>;

/** The workspace clock the two times on the card are read on. Off
 * `GET /v1/workspace/status`, which is the store's own row rather than a
 * provider listing, and which the chat already reads for everything else. */
const clockSchema = z.looseObject({
  workspace_clock: z.looseObject({ timezone: z.string().min(1) }).optional()
});

const readPost = async (client: PostdomClient, postId: string): Promise<PostRecord> =>
  postSchema.parse(await client.getPublish(postId));

const readClock = async (client: PostdomClient): Promise<string> =>
  clockSchema.parse(await client.getWorkspaceStatus()).workspace_clock?.timezone ?? "UTC";

/** The post as the card states it. Only ever built from what the API answered:
 * a destination this build cannot model is left out rather than described, and
 * a caption that is not there is an empty preview rather than an invention. */
function cardPost(post: PostRecord) {
  return {
    id: post.id,
    caption_preview: captionPreview(post.caption),
    destinations: (post.targets ?? []).flatMap((target) => {
      const platform = corePlatformSchema.safeParse(target.platform);
      return platform.success
        ? [{ platform: platform.data, handle: target.handle ?? null }]
        : [];
    }).slice(0, 30),
    run_url: runUrl(post.id)
  };
}

/** What the post was, and what it is, in the two fields the card compares. A
 * status this build does not model is reported as `unknown`, which is the one
 * the feed's own enum keeps for exactly that. */
function cardState(post: PostRecord) {
  const status = agentPostFeedStatusSchema.safeParse(post.status);
  return {
    status: status.success ? status.data : ("unknown" as const),
    scheduled_for: post.scheduled_for ?? null
  };
}

/** Said when the post is no longer due at the instant the call
 * named - somebody moved it, or it has already run - so the write is not sent
 * at all. The alternative was sending it anyway and reporting whatever
 * happened to a post the person was not looking at. */
const SCHEDULE_MOVED_DETAIL =
  "That post is not due at that time any more, so nothing was changed. This is where it stands now.";

/** The one act, from the read through the write to the read back.
 *
 * Both tools are the same four steps and differ only in which action they
 * send and whether they carry a new instant, so they are one function: a
 * second copy would be a second set of rules about when a write is refused. */
async function resolveSchedule(
  client: PostdomClient,
  input: { postId: string; scheduledFor: string; action: ScheduleChangeAction; publishAt?: string }
): Promise<ScheduleChange> {
  const [post, timezone] = await Promise.all([readPost(client, input.postId), readClock(client)]);
  const before = cardState(post);
  const card = (applied: boolean, after: PostRecord, blocked?: { code: string; detail: string }) =>
    scheduleChange({
      action: input.action,
      post: cardPost(after),
      before,
      after: cardState(after),
      applied,
      timezone,
      blocked: blocked ?? null
    });
  // The instant the caller named has to be the instant the post is on. This is
  // the same promise the version and the request hash make one field lower
  // down - the record you acted on is the record you were shown - said in the
  // one field a person can actually read in a sentence.
  const due = before.scheduled_for === null ? null : Date.parse(before.scheduled_for);
  if (due === null || Number.isNaN(due) || due !== Date.parse(input.scheduledFor)) {
    return card(false, post, { code: "schedule_moved", detail: SCHEDULE_MOVED_DETAIL });
  }
  try {
    await client.request("/dashboard/posts/" + encodeURIComponent(input.postId) + "/resolve", {
      method: "POST",
      body: JSON.stringify({
        version: post.version,
        request_hash: post.request_hash,
        // The page's own two actions. `cancel_schedule` returns the post to a
        // draft; `cancel` is the page's separate, terminal control and is not
        // offered here.
        action: input.action === "cancel" ? "cancel_schedule" : "reschedule",
        ...(input.publishAt ? { publish_at: input.publishAt } : {})
      })
    });
  } catch (error) {
    // A decision, in the words the route decided it in. Every other failure is
    // the call not landing at all, and the tool layer records that as
    // `unavailable` rather than as an answer.
    if (error instanceof PostdomApiError && (error.status === 409 || error.status === 423) && error.detail) {
      return card(false, await readPost(client, input.postId), {
        code: error.code ?? `http_${error.status}`,
        detail: error.detail
      });
    }
    throw error;
  }
  return card(true, await readPost(client, input.postId));
}

const postIdSchema = z.string().min(1).max(200);
/** The instant the post is on now, as the caller read it. */
const dueAtSchema = z.string().datetime();

export const POSTDOM_CHAT_SCHEDULE_TOOLS: readonly PostdomMcpToolDefinition[] = [
  defineTool({
    name: "cancel_post",
    title: "Cancel a scheduled post",
    description: "Cancel a post that has not gone out: it returns to a draft and nothing publishes. post_id and scheduled_for must be the id and the UTC instant the facts block or list_posts stated for that post; a post due at another time is refused rather than cancelled. Propose the cancellation and call this only when their next message agrees. A post that has already published or failed is refused in the API's own sentence. Answers a before → after card: report the card's summary, never a predicted outcome.",
    inputSchema: { post_id: postIdSchema, scheduled_for: dueAtSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(17,
      chatRead(new RegExp(`^/v1/posts/${NATIVE_CHAT_OPAQUE}$`)),
      chatRead(/^\/v1\/workspace\/status$/),
      chatWrite(new RegExp(`^/v1/dashboard/posts/${NATIVE_CHAT_OPAQUE}/resolve$`))),
    run: async (client, { post_id, scheduled_for }) =>
      resolveSchedule(client, { postId: post_id, scheduledFor: scheduled_for, action: "cancel" })
  }),
  defineTool({
    name: "reschedule_post",
    title: "Reschedule a post",
    description: "Move a post that has not gone out to a new time. post_id and scheduled_for name the post exactly as cancel_post does; publish_at is the new time as a future ISO UTC instant, resolved against the workspace clock. Propose the move and call this only when their next message agrees. A post that has already published or failed is refused in the API's own sentence. Answers a before → after card: report the card's summary, never a predicted outcome.",
    inputSchema: { post_id: postIdSchema, scheduled_for: dueAtSchema, publish_at: z.string().datetime() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(18,
      chatRead(new RegExp(`^/v1/posts/${NATIVE_CHAT_OPAQUE}$`)),
      chatRead(/^\/v1\/workspace\/status$/),
      chatWrite(new RegExp(`^/v1/dashboard/posts/${NATIVE_CHAT_OPAQUE}/resolve$`))),
    run: async (client, { post_id, scheduled_for, publish_at }) => {
      if (Date.parse(publish_at) === Date.parse(scheduled_for)) {
        throw new PostdomToolRefusal("publish_at is the time the post is already on");
      }
      return resolveSchedule(client, {
        postId: post_id,
        scheduledFor: scheduled_for,
        action: "reschedule",
        publishAt: publish_at
      });
    }
  })
];

export const POSTDOM_CHAT_SCHEDULE_TOOL_NAMES: readonly string[] =
  POSTDOM_CHAT_SCHEDULE_TOOLS.map((tool) => tool.name);
