import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { ListToolsRequestSchema, ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  REDIRECT_DESTINATIONS,
  // The compaction lives in core, not here. the app reads
  // these shapes back off a recorded step to decide whether a follow-up chip is
  // offered, and it cannot import this package - so a projection owned here was
  // a shape with two opinions about it, which is exactly how the app's gate came
  // to go on parsing the uncompacted answer.
  PERFORMANCE_ROWS_DEFAULT,
  PERFORMANCE_ROWS_MAX,
  agentPostFeedStatusSchema,
  compactDigest,
  compactPerformance,
  corePlatformSchema,
  type CorePlatform,
  MEDIA_ITEMS_MAX,
  mediaHandleSchema,
  mediaOperations,
  learningReadQuerySchema,
  learningReadEnvelopeSchema,
  mediaStatusResponseSchema,
  mediaUploadResponseSchema,
  performanceWindowSchema,
  SLIDESHOW_MAX_SLIDES,
  creativeBatchResponseSchema,
  accountMusicSchema,
  handoffSchema,
  musicHoldSchema,
  type AccountMusic,
  type Handoff,
  type MusicHold,
  type MusicMode,
  type CreativeBatchResponse,
  SLIDESHOW_SIZES,
  SLIDESHOW_TEMPLATES,
  slideshowCreateRequestSchema,
  slideshowResponseSchema,
  type SlideshowCreateRequest,
  type SlideshowResponse,
  postMediaSourceSchema,
  publishMediaSourceSchema,
  type PerformanceWindow,
  type MediaStatusResponse,
  type MediaUploadPreflightRequest,
  type MediaUploadResponse,
  PLAYBOOK_ONE_LINE
} from "@postdom/core";
import { z } from "zod";
import {
  NATIVE_CHAT_OPAQUE,
  NATIVE_CHAT_UUIDISH,
  PostdomApiError,
  PostdomToolRefusal,
  chatAdminWrite,
  chatRead,
  chatWrite,
  defineTool,
  nativeChat,
  type PostdomMcpToolDefinition,
  type PostdomNativeChatToolDefinition
} from "./registry";
import { POSTDOM_CHAT_RULES_TOOLS } from "./rules-tools";
import { POSTDOM_CHAT_SCHEDULE_TOOLS } from "./schedule-tools";
import { POSTDOM_AUTOPILOT_TOOLS } from "./autopilot-tools";
import { POSTDOM_CHAT_CREATE_TOOLS } from "./create-tools";
import { captionPreview, runUrl, utf8Bytes } from "./projection";

// The registry's vocabulary - the tool definition types, `defineTool`,
// the route helpers and the two error classes - moved to `./registry` so the
// rules tools can share it without a runtime cycle. Re-exported here, so every
// name this package has ever offered is still offered from the same place.
export {
  PostdomApiError,
  PostdomToolRefusal,
  type PostdomMcpToolDefinition,
  type PostdomNativeChatMetadata,
  type PostdomNativeChatRoute,
  type PostdomNativeChatRouteKind,
  type PostdomNativeChatToolDefinition
} from "./registry";
export { POSTDOM_CHAT_RULES_TOOLS, POSTDOM_CHAT_RULES_TOOL_NAMES } from "./rules-tools";
export { POSTDOM_CHAT_SCHEDULE_TOOLS, POSTDOM_CHAT_SCHEDULE_TOOL_NAMES } from "./schedule-tools";
export { POSTDOM_AUTOPILOT_TOOLS, POSTDOM_AUTOPILOT_TOOL_NAMES } from "./autopilot-tools";
export { POSTDOM_CHAT_CREATE_TOOLS, POSTDOM_CHAT_CREATE_TOOL_NAMES, CREATE_POSTS_DETAIL } from "./create-tools";

// Derived from core rather than restated: a hand-maintained copy in a file
// that already imports the schema is a divergence waiting to happen.
export type PostdomPlatform = CorePlatform;
export const POSTDOM_MCP_VERSION = "0.4.0";
/**
 * Every version of this package that has actually been published to npm, oldest
 * first.
 *
 * The manifest version is what the next publish will carry. This is what a
 * customer can install today, and the two are the same only after a publish has
 * happened. They were treated as one number, so bumping the manifest silently
 * rewrote every install instruction on the marketing site to a version npm does
 * not have. A version is added here by the act of publishing it, never ahead of
 * it: this list is evidence, not intent.
 */
export const POSTDOM_MCP_PUBLISHED_VERSIONS = ["0.1.0", "0.2.0", "0.3.0", "0.4.0"] as const;

const performanceMetricSchema = z.enum([
  "views",
  "likes",
  "comments",
  "shares",
  "saves",
  "watch_time_s",
  "avg_watch_pct",
  "completion_pct",
  "follower_delta"
]);

type PerformanceMetric = z.infer<typeof performanceMetricSchema>;

export interface PostdomAccount {
  id?: string;
  orgId?: string;
  providerAccountId: string;
  platform: string;
  handle?: string | null;
  status: string;
}

/** One workspace account list, shared by every tool call that needs one.
 *
 * `list_accounts`, `publish_video` and `submit_plan` each read `GET /v1/accounts`,
 * and `publish_video` and `submit_plan` read it to turn the account ids they
 * were given into platform targets. A chat turn calling all three read the same
 * list three times inside one attempt. The list cannot change under a turn in
 * any way that turn could act on - the accounts a publish is aimed at are
 * re-checked by the API on the publish itself - so one read per holder is the
 * whole difference.
 *
 * A holder, not a cache with a clock: whoever creates it decides how long it
 * lives, and the native chat creates one per attempt. A client constructed
 * without one reads the list per call exactly as it always did, which is what
 * an MCP agent's own client should do - its calls are minutes apart, not
 * milliseconds. */
export interface PostdomAccountList {
  accounts: Promise<PostdomAccount[]> | null;
}

export interface PostdomClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  agentIdentity?: string;
  accountList?: PostdomAccountList;
  oauthResourceMetadataUrl?: string;
  /**
   * The most time one `create_slideshow` may spend waiting for its slides, route wait
   * and polling together. 45 s by default, inside the 50 s an MCP client gives a tool call;
   * Postdom Chat sets 18 s so the call fits its step.
   */
  slideshowWaitMs?: number;
}

export class PostdomClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: PostdomClientOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.postdom.com/v1";
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /** OAuth failures alone request relinking; policy refusals and API keys retain their errors. */
  oauthChallenge(error: unknown): string | null {
    if (!this.options.apiKey.startsWith("pd_oauth_") || !(error instanceof PostdomApiError)) return null;
    const code = error.status === 401 ? "invalid_token"
      : error.status === 403 && error.code === "insufficient_scope" ? "insufficient_scope" : null;
    if (!code) return null;
    const resource = this.options.oauthResourceMetadataUrl
      ?? "https://api.postdom.com/.well-known/oauth-protected-resource";
    return 'Bearer resource_metadata=' + JSON.stringify(resource) + ', error="' + code + '", error_description="Reconnect Postdom with the required permissions"';
  }

  /** The API's own replay answer, carried on the body rather than left on a
   * header nobody downstream can see.
   *
   * A write with an `Idempotency-Key` that has been used before answers
   * `Idempotent-Replayed: true` and the original result. That is the difference
   * between "this created a post" and "this is the post you already have", and
   * a caller holding only the parsed body could not tell them apart - so the
   * chat's publish card had no way to say which of the two it was showing.
   * The flag is added, never overwritten: a route that some day answers the
   * field itself stays authoritative over a header. */
  private replayed<T>(payload: T, response: Response): T {
    if (response.headers.get("Idempotent-Replayed") !== "true") return payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
    const record = payload as Record<string, unknown>;
    return "idempotent_replayed" in record ? payload : { ...record, idempotent_replayed: true } as T;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.options.apiKey}`);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    const response = await this.fetch(`${this.baseUrl}${path}`, { ...init, headers });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const problem = typeof payload === "object" && payload !== null
        ? payload as Record<string, unknown>
        : {};
      const code = typeof problem.code === "string" ? ` ${problem.code}` : "";
      const detail = typeof problem.detail === "string" ? `: ${problem.detail}` : "";
      // The per-destination delivery gate returns a structured `destinations`
      // list precisely so an agent need not parse the detail sentence, and MCP
      // is the agent surface it exists for. Collapsing the problem document to
      // a message string dropped it, handing an agent publishing to several
      // destinations exactly the run-on prose the field was added to replace.
      //
      // Re-flattening it into "bluesky (video_max_bytes), linkedin (video_mime_types)" was the
      // same defect in a new spelling: still a sentence, still parsed. It travels two ways now -
      // on the error for a caller holding it, and verbatim as JSON in the message, because the
      // MCP SDK returns a thrown error to the agent as its message text and nothing else.
      const destinations = Array.isArray(problem.destinations)
        ? problem.destinations
            .filter((entry): entry is { platform: string; fact: string } =>
              typeof entry === "object" && entry !== null
              && typeof (entry as { platform?: unknown }).platform === "string"
              && typeof (entry as { fact?: unknown }).fact === "string")
            .map(({ platform, fact }) => ({ platform, fact }))
        : [];
      const blocked = destinations.length > 0
        ? ` Destinations that cannot receive this video: ${JSON.stringify(destinations)}.`
        : "";
      throw new PostdomApiError(
        `Postdom API request failed with HTTP ${response.status}${code}${detail}${blocked}`,
        response.status,
        typeof problem.code === "string" ? problem.code : null,
        destinations,
        typeof problem.detail === "string" ? problem.detail : null,
        problem
      );
    }
    return this.replayed(payload as T, response);
  }

  async listAccounts(): Promise<PostdomAccount[]> {
    const holder = this.options.accountList;
    if (!holder) {
      const response = await this.request<{ accounts: PostdomAccount[] }>("/accounts");
      return response.accounts;
    }
    // The promise is held, not the value: two calls that overlap share the one
    // request rather than racing two. A failed read is not kept - the holder is
    // cleared so the next call asks again instead of replaying an outage.
    holder.accounts ??= this.request<{ accounts: PostdomAccount[] }>("/accounts")
      .then((response) => response.accounts)
      .catch((error: unknown) => { holder.accounts = null; throw error; });
    return [...(await holder.accounts)];
  }

  getWorkspaceStatus(): Promise<Record<string, unknown>> {
    return this.request("/workspace/status");
  }

  connectAccount(platform: PostdomPlatform): Promise<Record<string, unknown>> {
    return this.request("/accounts/connect", {
      method: "POST",
      body: JSON.stringify({
        platform,
        redirect_url: "https://app.postdom.com/accounts"
      })
    });
  }

  async createMediaUpload(input: MediaUploadPreflightRequest): Promise<MediaUploadResponse> {
    const request = mediaOperations.createUpload.request.parse(input);
    const response = await this.request<unknown>(mediaOperations.createUpload.path, {
      method: mediaOperations.createUpload.method,
      body: JSON.stringify(request)
    });
    return mediaUploadResponseSchema.parse(response);
  }

  async getMedia(mediaHandle: string): Promise<MediaStatusResponse> {
    const { media_handle } = mediaOperations.getUpload.params.parse({
      media_handle: mediaHandle
    });
    const response = await this.request<unknown>(
      mediaOperations.getUpload.path.replace(
        "{media_handle}",
        encodeURIComponent(media_handle)
      )
    );
    return mediaStatusResponseSchema.parse(response);
  }

  async publishVideo(input: {
    accountIds: string[];
    videoUrl?: string;
    mediaHandle?: string;
    media?: readonly { mediaUrl?: string; mediaHandle?: string }[];
    caption: string;
    intent: string;
    agentIdentity?: string;
    publishAt?: string;
    planId?: string;
    idempotencyKey?: string;
    /** Surface per destination, keyed by platform. Absent means the media decides. */
    surface?: Record<string, string>;
    title?: string;
    description?: string;
  }): Promise<Record<string, unknown>> {
    // Keep the existing media-required scalar contract. REST also permits text-only posts,
    // but publish_video does not. Validate lists here, not just in the tool, so direct client
    // callers cannot silently discard a list when a scalar source is also present.
    if (input.media === undefined) {
      publishMediaSourceSchema.parse({ video_url: input.videoUrl, media_handle: input.mediaHandle });
    } else if (!Array.isArray(input.media)) {
      // JavaScript callers can bypass the TypeScript signature. In particular, null must not
      // collapse to an absent list and accidentally enable REST's text-only publishing path.
      throw new Error("media must be an ordered array of media items");
    }
    const mediaSource = postMediaSourceSchema.parse({
      media_url: input.videoUrl,
      media_handle: input.mediaHandle,
      media: input.media?.map((item) => ({ media_url: item.mediaUrl, media_handle: item.mediaHandle }))
    });
    const accounts = await this.listAccounts();
    const byId = new Map(accounts.map((account) => [account.providerAccountId, account]));
    const targets = input.accountIds.map((accountId) => {
      const account = byId.get(accountId);
      if (!account) throw new Error(`Postdom account ${accountId} is not connected`);
      // Parsed rather than cast. The platform arrives as a string from the API,
      // and naming the destination Postdom does not recognise is more useful
      // than a generic failure further down the publish path.
      const platform = corePlatformSchema.safeParse(account.platform);
      if (!platform.success) {
        throw new Error(`Postdom account ${accountId} is connected to an unrecognised destination`);
      }
      return defaultTarget(platform.data, accountId, input.caption, {
        surface: input.surface?.[platform.data],
        title: input.title,
        description: input.description
      });
    });
    return this.request<Record<string, unknown>>("/posts", {
      method: "POST",
      headers: {
        "Idempotency-Key": input.idempotencyKey ?? randomUUID(),
        "X-Postdom-Source": "mcp"
      },
      body: JSON.stringify({
        caption: input.caption,
        ...mediaSource,
        publish_at: input.publishAt,
        plan_id: input.planId,
        targets,
        agent_context: {
          identity: this.options.agentIdentity ?? input.agentIdentity ?? "AI agent via MCP",
          intent: input.intent
        }
      })
    });
  }

  async submitPlan(input: {
    accountIds: string[];
    title: string;
    objective: string;
    startsAt: string;
    endsAt: string;
    maxPosts: number;
    briefVersion?: number;
    intent: string;
    agentIdentity?: string;
    idempotencyKey?: string;
  }): Promise<Record<string, unknown>> {
    const accounts = await this.listAccounts();
    const byId = new Map(accounts.map((account) => [account.providerAccountId, account]));
    const targets = input.accountIds.map((accountId) => {
      const account = byId.get(accountId);
      if (!account) throw new Error(`Postdom account ${accountId} is not connected`);
      return { account_id: accountId, platform: account.platform };
    });
    return this.request<Record<string, unknown>>("/plans", {
      method: "POST",
      headers: {
        "Idempotency-Key": input.idempotencyKey ?? randomUUID(),
        "X-Postdom-Source": "mcp"
      },
      body: JSON.stringify({
        title: input.title,
        objective: input.objective,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        max_posts: input.maxPosts,
        brief_version: input.briefVersion,
        targets,
        agent_context: {
          identity: this.options.agentIdentity ?? input.agentIdentity ?? "AI agent via MCP",
          intent: input.intent
        }
      })
    });
  }

  getPlan(planId: string): Promise<Record<string, unknown>> {
    return this.request(`/plans/${encodeURIComponent(planId)}`);
  }

  getBrief(): Promise<Record<string, unknown>> {
    return this.request("/brief");
  }

  /**
   * Render brand-kit slides into image media, waiting for them.
   *
   * One budget covers the whole call (review round 2, finding 4): the route is asked to wait at
   * most 20 s of it (`Prefer: wait`), and a 202 is then polled on `GET /slideshows/{id}` until
   * the budget is spent - 45 s by default, so the call returns inside an MCP client's 50 s. If
   * the slides are still rendering then, the answer says so with the Idempotency-Key: the same
   * call with the same key answers the same slideshow instead of rendering it again.
   */
  async createSlideshow(input: {
    size: SlideshowCreateRequest["size"];
    slides: SlideshowCreateRequest["slides"];
    idempotencyKey?: string;
    waitMs?: number;
    pollMs?: number;
  }): Promise<SlideshowResponse & { idempotency_key: string }> {
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    const body = slideshowCreateRequestSchema.parse({ size: input.size, slides: input.slides });
    const budgetMs = Math.max(1_000, input.waitMs ?? this.options.slideshowWaitMs ?? 45_000);
    const deadline = Date.now() + budgetMs;
    // Whole seconds, a second short of the budget for the request's own round trip.
    const routeWaitSeconds = Math.max(1, Math.min(20, Math.floor(budgetMs / 1_000) - 1));
    let current = slideshowResponseSchema.parse(await this.request<unknown>("/slideshows", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey, "X-Postdom-Source": "mcp", Prefer: `wait=${routeWaitSeconds}` },
      body: JSON.stringify(body)
    }));
    while (current.status === "rendering" && deadline - Date.now() > (input.pollMs ?? 1_500)) {
      await new Promise((resolve) => setTimeout(resolve, input.pollMs ?? 1_500));
      current = await this.getSlideshow(current.slideshow_id);
    }
    return { ...current, idempotency_key: idempotencyKey };
  }

  async getSlideshow(slideshowId: string): Promise<SlideshowResponse> {
    return slideshowResponseSchema.parse(await this.request<unknown>(`/slideshows/${encodeURIComponent(slideshowId)}`));
  }

  /** Start a creative batch: drafts written from the workspace's Brand Brain. */
  async generateContent(input: { count?: number } = {}): Promise<CreativeBatchResponse> {
    return creativeBatchResponseSchema.parse(await this.request<unknown>("/creative/batches", {
      method: "POST",
      headers: { "X-Postdom-Source": "mcp" },
      body: JSON.stringify(input.count === undefined ? {} : { count: input.count })
    }));
  }

  /** A creative batch with its drafts, in any state. */
  async getContentBatch(batchId: string): Promise<CreativeBatchResponse> {
    return creativeBatchResponseSchema.parse(await this.request<unknown>(`/creative/batches/${encodeURIComponent(batchId)}`));
  }

  /** Each account's music choice and the TikTok inbox holds. */
  async getMusic(): Promise<{ accounts: AccountMusic[]; holds: MusicHold[] }> {
    return z.object({ accounts: z.array(accountMusicSchema), holds: z.array(musicHoldSchema) }).parse(await this.request<unknown>("/music"));
  }

  /** Sets who adds the music on one account. */
  async setAccountMusic(accountId: string, music: MusicMode): Promise<AccountMusic & { upcoming: number; in_inbox: number }> {
    return accountMusicSchema.extend({ upcoming: z.number(), in_inbox: z.number() }).parse(await this.request<unknown>(`/music/accounts/${encodeURIComponent(accountId)}`, {
      method: "PUT",
      body: JSON.stringify({ music })
    }));
  }

  /** The TikTok inbox and Instagram "Post it myself" states of posts. */
  async getHandoffs(postIds: readonly string[] = []): Promise<Handoff[]> {
    const query = postIds.length ? `?post_ids=${postIds.map(encodeURIComponent).join(",")}` : "";
    return z.object({ handoffs: z.array(handoffSchema) }).parse(await this.request<unknown>(`/music/handoffs${query}`)).handoffs;
  }

  async getDigest(): Promise<Record<string, unknown>> {
    return compactDigest(await this.request<Record<string, unknown>>("/digest"));
  }

  async getLearning(raw:unknown={}) {
    const input=learningReadQuerySchema.parse(raw);
    const query=input.scopeId?`?scopeId=${encodeURIComponent(input.scopeId)}`:'';
    return learningReadEnvelopeSchema.parse(await this.request(`/learning${query}`));
  }

  getPublish(postId: string): Promise<Record<string, unknown>> {
    return this.request(`/posts/${encodeURIComponent(postId)}`);
  }

  /** The workspace's posts, as a list rather than one id at a time.
   *
   * `getPublish` answers about a post whose id the caller already
   * has, which is no use at all to the question a person actually asks - "what
   * is scheduled this week" - because the ids are exactly what they do not
   * have. Production, 16 September: the home screen's own example chip produced
   * "I can't retrieve a calendar/list of them with the available records",
   * because that was true.
   *
   * The reply is reshaped rather than passed through, and that is the whole
   * difference between a tool a model can use and a page of JSON it has to
   * summarise. `GET /v1/posts` answers the agent feed item whole - every
   * caption, every publish row, every provider id and public URL - and four
   * days of a busy workspace is tens of kilobytes the recorded step cannot
   * hold. What a schedule question needs is the time, the destination, the
   * state and enough of the caption to recognise the post, so that is what is
   * kept; a caller who needs the rest has `get_publish` and the post's id,
   * which this is what hands them. */
  async listPosts(input: {
    status?: readonly string[];
    from?: string;
    to?: string;
    account?: string;
    limit: number;
  }): Promise<Record<string, unknown>> {
    const query = new URLSearchParams();
    if (input.status?.length) query.set("status", [...input.status].join(","));
    if (input.from) query.set("scheduled_from", input.from);
    if (input.to) query.set("scheduled_to", input.to);
    if (input.account) query.set("account_id", input.account);
    query.set("limit", String(input.limit));
    const response = await this.request<{
      posts?: unknown;
      next_cursor?: unknown;
    }>(`/posts?${query.toString()}`);
    const posts = Array.isArray(response.posts) ? response.posts : [];
    const summarised = posts.map((post) => summarisePost(post));
    const envelope = {
      next_cursor: typeof response.next_cursor === "string" ? response.next_cursor : null,
      // Echoed, because the answer has to be able to say what was asked. An
      // empty list means "nothing in THIS window", and a reader holding only
      // the empty list cannot tell which window that was.
      window: input.from || input.to ? { from: input.from ?? null, to: input.to ?? null } : null
    };
    // The page is stopped here rather than left to be halved
    // later. A fifty-post page is about 29 KB, past what a recorded chat step
    // can hold, and the tool layer's backstop would have cut it to whatever
    // number of rows happened to fit - a silent halving that told the reader
    // nothing about the shape of what it kept. Cut in order, at a stated bound,
    // and said out loud.
    const kept: Record<string, unknown>[] = [];
    for (const post of summarised) {
      const candidate = [...kept, post];
      // Measured WITH the markers a cut answer carries, always - about sixty
      // bytes this page may not end up spending. Measuring the page without
      // them is the same defect one layer down: a page that fits the bound
      // exactly and then grows three fields for saying it was cut is a page
      // over the bound, refused for the announcement rather than for the data.
      // The cost of being conservative here is one row, on the safe side.
      const measured = {
        ...envelope,
        posts: candidate,
        truncated: true,
        posts_total: summarised.length,
        posts_returned: candidate.length
      };
      if (kept.length > 0 && utf8Bytes(measured) > LIST_POSTS_ANSWER_BYTES) break;
      kept.push(post);
    }
    return {
      posts: kept,
      ...envelope,
      ...(kept.length < summarised.length
        // `posts_total` is what THIS page held, not what the filters match -
        // that is `next_cursor`'s job, and conflating the two would let a
        // reader report a page as a workspace.
        ? { truncated: true, posts_total: summarised.length, posts_returned: kept.length }
        : {})
    };
  }

  async getPostPerformance(postId: string, limit = PERFORMANCE_ROWS_DEFAULT): Promise<Record<string, unknown>> {
    return compactPerformance(
      await this.request<Record<string, unknown>>(`/posts/${encodeURIComponent(postId)}/performance`),
      limit
    );
  }

  async getAccountPerformance(
    accountId: string,
    window: PerformanceWindow,
    limit = PERFORMANCE_ROWS_DEFAULT
  ): Promise<Record<string, unknown>> {
    return compactPerformance(
      await this.request<Record<string, unknown>>(
        `/accounts/${encodeURIComponent(accountId)}/performance?window=${window}`
      ),
      limit
    );
  }

  getBestPosts(
    accountId: string,
    metric: PerformanceMetric,
    window: PerformanceWindow
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/best-posts?metric=${encodeURIComponent(metric)}&window=${window}`
    );
  }
}

/** What a whole `list_posts` answer may weigh.
 *
 * Comfortably inside the chat's own answer bound
 * (`NATIVE_CHAT_LIMITS.toolResultBytes / 2`, 16 KiB) rather than at it: the
 * recorded step carries the digest, the name and the destinations beside the
 * answer, and a tool that fills the bound exactly leaves the backstop to do the
 * cutting - which is the silent halving this number exists to prevent. Stated
 * here rather than imported, because packages/mcp does not depend on the chat's
 * limits and should not start: this is the tool's own promise about its own
 * answer, and it holds for an agent over MCP that has no chat bound at all. */
const LIST_POSTS_ANSWER_BYTES = 12 * 1024;

/** One agent-feed post, reduced to what a schedule answer is about.
 *
 * Read defensively rather than parsed: this is a projection for a model, and a
 * field the API adds tomorrow must not be able to take the whole list down. A
 * field that is not there is left out; nothing here is invented to fill a gap.
 */
function summarisePost(post: unknown): Record<string, unknown> {
  const record = typeof post === "object" && post !== null ? post as Record<string, unknown> : {};
  const id = typeof record.id === "string" ? record.id : null;
  const targets = Array.isArray(record.targets) ? record.targets : [];
  const publishes = Array.isArray(record.publishes) ? record.publishes : [];
  // The public URL belongs to the destination that published, and it is on the
  // publish row rather than on the target. Joined by account so a two-
  // destination post cannot show one destination's link against the other's
  // handle.
  const published = new Map<string, string>();
  for (const publish of publishes) {
    const row = typeof publish === "object" && publish !== null ? publish as Record<string, unknown> : {};
    if (typeof row.account_id === "string" && typeof row.public_url === "string") {
      published.set(row.account_id, row.public_url);
    }
  }
  return {
    ...(id ? { id } : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    scheduled_for: typeof record.scheduled_for === "string" ? record.scheduled_for : null,
    caption_preview: captionPreview(record.caption),
    destinations: targets.map((target) => {
      const row = typeof target === "object" && target !== null ? target as Record<string, unknown> : {};
      const accountId = typeof row.account_id === "string" ? row.account_id : null;
      return {
        ...(accountId ? { account_id: accountId } : {}),
        ...(typeof row.platform === "string" ? { platform: row.platform } : {}),
        handle: typeof row.handle === "string" ? row.handle : null,
        // Null until this destination published. A link that is not there is
        // not a link that failed, and the status beside it says which.
        post_url: accountId ? published.get(accountId) ?? null : null
      };
    }),
    // The run, which is where a human reads what happened to this post. Only
    // ever built from an id the API answered with.
    ...(id ? { run_url: runUrl(id) } : {})
  };
}

// `platform` is CorePlatform, not string. As `string` this function could never
// be checked for exhaustiveness, so adding a destination compiled cleanly and
// threw at publish time - which is what happened when Bluesky was added. The
// caller now parses the provider's value with corePlatformSchema, so an
// unrecognised destination fails where it is read rather than six frames later.
/**
 * The three extras a tool call may name, and what each does when it does not.
 *
 * Every one is optional and every omission rebuilds the target this function built before this
 * release. surface is a sibling of settings, not a key inside it, because settings are what reach
 * the transport and no transport has a field by that name.
 */
interface McpTargetExtras {
  surface?: string;
  title?: string;
  description?: string;
}

function defaultTarget(
  platform: CorePlatform,
  accountId: string,
  caption: string,
  extras: McpTargetExtras = {}
) {
  const surface = extras.surface ? { surface: extras.surface } : {};
  if (platform === "tiktok") {
    return {
      account_id: accountId,
      platform,
      ...surface,
      settings: {
        // TikTok goes out public by default, like the app, the API and core.
        privacy_level: "PUBLIC_TO_EVERYONE",
        allow_comment: false,
        allow_duet: false,
        allow_stitch: false,
        content_preview_confirmed: true,
        express_consent_given: true,
        video_made_with_ai: true
      }
    };
  }
  if (platform === "instagram") {
    return {
      account_id: accountId,
      platform,
      ...surface,
      settings: { contentType: "reel", isAiGenerated: true }
    };
  }
  if (platform === "youtube") {
    return {
      account_id: accountId,
      platform,
      ...surface,
      settings: {
        // A named title wins; the caption first line stays the default.
        title: extras.title?.trim() ? extras.title.trim().slice(0, 100) : caption.split("\n")[0]?.slice(0, 100) || "Postdom video",
        ...(extras.description?.trim() ? { description: extras.description.trim() } : {}),
        // Stays private for agents, like the SDK: the website documents this default for agent
        // posts. The in-app composer defaults to public.
        visibility: "private",
        madeForKids: false,
        containsSyntheticMedia: true
      }
    };
  }
  if (platform === "facebook") {
    return {
      account_id: accountId,
      platform,
      ...surface,
      settings: { contentType: "reel" }
    };
  }
  if (platform === "twitter") {
    return {
      account_id: accountId,
      platform,
      ...surface,
      settings: {}
    };
  }
  if (platform === "linkedin") {
    // Postdom sends no LinkedIn-specific settings; the provider chooses the
    // required visibility value on our behalf and does not expose it.
    return {
      account_id: accountId,
      platform,
      ...surface,
      settings: {}
    };
  }
  if (platform === "bluesky") {
    // blueskySettingsSchema is empty: the destination takes no settings at all.
    return {
      account_id: accountId,
      platform,
      ...surface,
      settings: {}
    };
  }
  if (platform === "snapchat") {
    // No snapchatSettingsSchema exists: Postdom sends no Snapchat-specific
    // settings, so an empty object is the whole payload. The Spotlight endpoint
    // does take skip_save_to_profile, and when Postdom starts sending it this is
    // one of the places it has to appear.
    return {
      account_id: accountId,
      platform,
      ...surface,
      settings: {}
    };
  }
  if (platform === "threads") {
    // Postdom sends no Threads-specific settings, so an empty object is the whole payload. The
    // publishing endpoint does take topic_tag, and when Postdom starts sending it this is one of
    // the places it has to appear.
    //
    // This was Snapchat's comment, copied: it named skip_save_to_profile - a Snap Spotlight
    // parameter - and told a future implementer to add it to a Threads target.
    return {
      account_id: accountId,
      platform,
      ...surface,
      settings: {}
    };
  }
  // Binding to `never` is what makes the next destination a build error here.
  const unsupported: never = platform;
  throw new Error(`publish_video does not support ${String(unsupported)}`);
}

/**
 * A refusal for the plan allowance or credits, as a structured tool error a connected
 * agent can act on and tell its user about: the code, when it resets, and where to upgrade or top
 * up. Null for every other error (it is thrown as before).
 */
export function allowanceToolError(error: unknown) {
  if (!(error instanceof PostdomApiError) || !error.problem) return null;
  const problem = error.problem;
  if (typeof problem.upgrade_url !== "string" || typeof problem.topup_url !== "string") return null;
  const structured = {
    error: {
      code: error.code ?? (typeof problem.code === "string" ? problem.code : "allowance_used"),
      reset_at: typeof problem.reset_at === "string" ? problem.reset_at : null,
      upgrade_url: problem.upgrade_url,
      topup_url: problem.topup_url,
      detail: error.detail,
      // A workspace viewed as a plan: the refusal is that plan's, and says so.
      ...(typeof problem.viewing_as === "string" ? { viewing_as: problem.viewing_as } : {})
    }
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured
  };
}

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

export const POSTDOM_MCP_TOOLS: readonly PostdomMcpToolDefinition[] = [
  defineTool({
    name: "get_workspace_status",
    title: "Get workspace status",
    description: "Read the workspace overview, usually the opening call of a session: connected-account health, autonomy and policy state, the server-resolved workspace clock and observation instant, brief version, activity counts, the connection gate, raw subscription state, and effective current billing permission. A raw subscription status is not a publish decision. Current billing permission is a snapshot, not a reservation for a future publish; publish_video performs authoritative admission for its requested publish_at.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(0, chatRead(/^\/v1\/workspace\/status$/)),
    run: async (client) => client.getWorkspaceStatus()
  }),
  defineTool({
    name: "get_brief",
    title: "Get workspace brief",
    description: "Read the current workspace-owned brand guidance before planning or writing content. brand_kit holds colours, fonts, logos and slide templates; logo URLs expire, call get_brief again for fresh ones.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(1, chatRead(/^\/v1\/brief$/)),
    run: async (client) => client.getBrief()
  }),
  defineTool({
    name: "get_digest",
    title: "Get latest learning digest",
    // The answer is the summary and the counts, with the evidence
    // lists behind them bounded and each saying how many it had. A four-account
    // week is 23 KiB whole, two thirds of it `top_posts` repeating the same
    // population sentence - an answer that could not be recorded at all, which
    // is how a question about the week came to be answered from nothing.
    description: "Read the latest completed weekly workspace digest before planning. It describes observed outcomes, populations, cadence endings, and coverage gaps; it does not recommend actions. The summary and the activity counts are whole. The evidence lists beside them - top posts, failure reasons, runs, coverage notes - are the first few of each, with a `_total` beside every one saying how many there are; the reply carries truncated: true when any of them was shortened. The population definition is stated once rather than on every figure.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(2, chatRead(/^\/v1\/digest$/)),
    run: async (client) => client.getDigest()
  }),
  defineTool({
    name: "get_learning",
    title: "Read shared account learning",
    // `scopeId` was already optional and said so nowhere, which is
    // the same thing as being required to a model: with no default stated, the
    // only way to call the tool was to supply an id, and the ids a model has to
    // hand are the ones it invented. Every one of those is refused by the uuid
    // parser or by the route, and the turn spends a payable step learning that.
    // So the default is documented in both places a caller reads - here and on
    // the field - and the sentence names what omission actually does rather
    // than merely permitting it.
    description: "Read saved, source-linked account observations and exploratory advice. Omit scopeId to read the whole workspace, which is the default and the right call unless the human named one account; never invent, guess or construct a scopeId. Missing or invalidated advice is not evidence of growth. This cannot apply, correct, fund, approve or publish anything; unpublished content is never returned.",
    inputSchema: learningReadQuerySchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(3, chatRead(/^\/v1\/learning$/)),
    run: async (client, input) => client.getLearning(input)
  }),
  defineTool({
    name: "list_accounts",
    title: "List connected accounts",
    description: "List workspace destination accounts, synchronizing their provider state into Postdom.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(4, chatRead(/^\/v1\/accounts$/)),
    run: async (client) => ({ accounts: await client.listAccounts() })
  }),
  defineTool({
    name: "connect_account",
    title: "Connect social account",
    description: "Create a platform OAuth URL for a destination that authorises by redirect. Hand the returned URL to the human; never ask for or handle their social password. Destinations that authorise with an app password instead are connected by a human in the Postdom dashboard and are deliberately absent from the platform enum - there is no credential tool here, and there should not be.",
    // Offered, not accepted. A tool schema is the menu an agent reads, and an agent is the
    // customer here - so it lists what a customer can actually connect, the same narrowing the
    // dashboard, Make, n8n and Zapier pickers already have. corePlatformSchema stays the wire
    // contract: POST /v1/accounts/connect still accepts every core platform, because refusing one
    // the API would take is a client bug. Offering one with no Connect path is a guaranteed
    // failure the agent cannot diagnose - it would hand a human a URL for a destination that
    // cannot exist.
    // REDIRECT_DESTINATIONS, not CONNECT_DESTINATIONS, and the comment above is why. This read
    // the offered list, which was the same set until Bluesky was claimed - and then this tool
    // offered an agent a destination it cannot connect: connectAccount returns an OAuth URL, and
    // Bluesky has none. The agent would hand a human a URL for a screen that does not exist, or
    // surface a provider error it has no way to interpret. That is precisely the "guaranteed
    // failure the agent cannot diagnose" this comment already warned about, arriving through the
    // one list that had not learned to ask how a destination connects.
    inputSchema: { platform: z.enum(REDIRECT_DESTINATIONS) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    nativeChat: nativeChat(10, chatAdminWrite(/^\/v1\/accounts\/connect$/)),
    run: async (client, { platform }) => client.connectAccount(platform)
  }),
  defineTool({
    name: "upload_media",
    title: "Upload media",
    description: "Create a short-lived, workspace-scoped PUT URL for finished video or image bytes. Supply measured width_pixels and height_pixels as positive integers; never guess or default them. Supply duration_seconds for a video and omit it for an image. platforms is optional: omit it to check the asset against the global limits only, or declare the intended destinations to have their own limits checked now; every destination's limits are checked again when the asset is published to it. Upload the exact declared bytes directly to the returned URL, then call get_media until the handle is stored.",
    inputSchema: mediaOperations.createUpload.request.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    // An MCP tool, and deliberately not a chat tool: there is no
    // `nativeChat` metadata here any more.
    //
    // An external agent holds the bytes and can PUT them. A chat turn holds
    // none - `prepareWrite` refuses every publish whose media handle the person
    // did not attach to the turn - so the only thing this could produce on the
    // chat menu was a handle no publish would ever accept, discovered three
    // model steps in. Withdrawing the metadata withdraws the route with it:
    // `NATIVE_CHAT_ROUTES` is derived from this list, so a chat capability
    // cannot reach POST /v1/media/uploads at all, however it was obtained.
    //
    // Nothing about the MCP contract changes: same name, description, schema
    // and handler, offered to every agent exactly as before.
    //
    // Chat order 11 was left unused rather than backfilled, because the numbers
    // only sort the menu and renumbering the two writes below would have made
    // this removal read as a reordering in every future diff. a later change gave
    // that number to `list_posts`, which is what leaving it free was for: a new
    // tool takes it and nothing else moves.
    run: async (client, input) => client.createMediaUpload(input)
  }),
  defineTool({
    name: "get_media",
    title: "Get media",
    description: "Verify workspace media after its direct PUT, recording stored or failed state and optionally queuing a probe. Continue only when stored; preserve pending or failed. kind identifies video or image.",
    inputSchema: { media_handle: mediaHandleSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(5, chatRead(new RegExp(`^/v1/media/${NATIVE_CHAT_OPAQUE}$`))),
    run: async (client, { media_handle }) => client.getMedia(media_handle)
  }),
  defineTool({
    name: "publish_video",
    title: "Publish video",
    // Every byte of this description is charged against the native chat's per-turn admission
    // bound - `native-openai-chat-adapter.test.ts` pins the whole menu's cost against a ceiling
    // the runbook's configured floor is derived from - so the carousel rule is stated in one
    // clause rather than in a sentence of its own.
    description: "Create a publish with each provider's supported safety defaults, optionally scheduled in UTC. media_handle may be a video or an image; video_url is a video. Posts flow automatically inside an account's policy or await review on review-mode accounts. Name media once: video_url, media_handle, or media for an ordered carousel; not every destination takes one, and the refusal names it. surface (native chat: surfaces, one {platform, surface} item per destination) picks where a post lands where a network has more than one place: instagram takes reel or story for video, feed for images and carousels - Instagram publishes every video as a Reel, so feed is refused for one; facebook takes reel, feed or story; youtube takes short or long_form; omit it and the media decides. title and description are YouTube only.",
    inputSchema: {
      account_ids: z.array(z.string()).min(1),
      video_url: z.url().optional(),
      media_handle: mediaHandleSchema.optional(),
      /**
       * The ordered items, each naming exactly one source.
       *
       * Declared here rather than reached through `postMediaSourceSchema` because this tool's
       * singular field is `video_url` and the REST route's is `media_url`: the adaptation happens
       * at the transport boundary, and it has since the tool was written. The per-item names ARE
       * the REST ones, so the list travels through unchanged.
       *
       * `media_handle` is a bare string here rather than `mediaHandleSchema`, and the shape is
       * checked by that schema in `run` below instead. The regex is ninety bytes and it already
       * appears twice in this menu - on `media_handle` and on `get_media` - and the menu is
       * charged against the native chat's per-turn admission bound in full. A third copy bought
       * nothing: the model has the format in front of it, and an item that does not match it is
       * refused before a request is built.
       */
      media: z.array(z.object({
        media_url: z.url().optional(),
        media_handle: z.string().min(1).optional()
      })).min(1).max(MEDIA_ITEMS_MAX).optional(),
      caption: z.string().max(4_000),
      intent: z.string().trim().min(1).max(500),
      agent_identity: z.string().trim().min(1).max(120).optional(),
      /**
       * Surface per destination, and YouTube metadata.
       *
       * A plain string map rather than nine per-destination enums, and that is a size decision
       * as much as a shape one: keyed enums would put every member of every catalogue into this
       * menu, which is charged in full against the native chat per-turn admission bound. The
       * members are named in one clause of the description instead, and a wrong one comes back
       * as a 422 from the schema that actually owns them.
       */
      surface: z.record(z.string(), z.string()).optional(),
      title: z.string().trim().min(1).max(100).optional(),
      description: z.string().max(5_000).optional(),
      publish_at: z.string().datetime().optional(),
      plan_id: z.string().uuid().optional(),
      idempotency_key: z.string().min(1).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    nativeChat: nativeChat(12, chatWrite(/^\/v1\/posts$/)),
    run: async (client, { account_ids, video_url, media, media_handle, caption, intent, agent_identity, surface, title, description, publish_at, plan_id, idempotency_key }) => {
      // Preserve both item fields during adaptation: the actual MCP client validates their
      // exclusivity and handle shape against core before any account lookup or write.
      return client.publishVideo({
        accountIds: account_ids,
        ...(media !== undefined
          ? {
              media: media.map((item) => ({ mediaHandle: item.media_handle, mediaUrl: item.media_url }))
            }
          : {}),
        videoUrl: video_url,
        mediaHandle: media_handle,
        caption,
        intent,
        surface,
        title,
        description,
        agentIdentity: agent_identity,
        publishAt: publish_at,
        planId: plan_id,
        idempotencyKey: idempotency_key
      });
    }
  }),
  defineTool({
    name: "submit_plan",
    title: "Submit publication plan",
    description: "Submit a time-bounded L2 publication plan for one human approval.",
    inputSchema: {
      account_ids: z.array(z.string()).min(1),
      title: z.string().trim().min(1).max(120),
      objective: z.string().trim().min(1).max(1_000),
      starts_at: z.string().datetime(),
      ends_at: z.string().datetime(),
      max_posts: z.number().int().min(1).max(20),
      brief_version: z.number().int().positive().optional(),
      intent: z.string().trim().min(1).max(500),
      agent_identity: z.string().trim().min(1).max(120).optional(),
      idempotency_key: z.string().min(1).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(13, chatWrite(/^\/v1\/plans$/)),
    run: async (client, { account_ids, title, objective, starts_at, ends_at, max_posts, brief_version, intent, agent_identity, idempotency_key }) => client.submitPlan({
      accountIds: account_ids,
      title,
      objective,
      startsAt: starts_at,
      endsAt: ends_at,
      maxPosts: max_posts,
      briefVersion: brief_version,
      intent,
      agentIdentity: agent_identity,
      idempotencyKey: idempotency_key
    })
  }),
  defineTool({
    name: "get_plan",
    title: "Get publication plan",
    description: "Read plan status and structured feedback from the human reviewer.",
    inputSchema: { plan_id: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(6, chatRead(new RegExp(`^/v1/plans/${NATIVE_CHAT_UUIDISH}$`))),
    run: async (client, { plan_id }) => client.getPlan(plan_id)
  }),
  defineTool({
    name: "get_publish",
    title: "Get publish",
    description: "Read publish state and any structured approval feedback returned by the human reviewer.",
    inputSchema: { post_id: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(7, chatRead(new RegExp(`^/v1/posts/${NATIVE_CHAT_OPAQUE}$`))),
    run: async (client, { post_id }) => client.getPublish(post_id)
  }),
  defineTool({
    name: "list_posts",
    title: "List posts",
    // The tool the chat did not have, named by the defect: asked
    // "show me what's scheduled this week" - the home screen's own example chip
    // - production answered "I don't have a schedule-listing view available in
    // this workspace". Every posts tool took an id, and an id is exactly what
    // the person asking that question does not have.
    //
    // The description says what the order is, because the order is not the one
    // a schedule question wants. The feed pages most-recently-updated first, and
    // the cursor is bound to that; reordering the page by publish time inside
    // this tool would be a list selected by one key and presented as if sorted
    // by another. So it is stated instead, and the sorting is left to the
    // caller, which can see all of it.
    description: "List this workspace's posts, which is the only way to answer what is scheduled without already holding an id. Filter by status (one or several), by a publish-time window, and by one connected account. from and to bound scheduled_for and are absolute ISO instants: resolve the human's local dates against the workspace clock first, exactly as publish_at requires, and remember a post with no publish time is in no window. Answers id, status, scheduled time as a UTC instant, destinations with their handles, a bounded caption preview, the run link and each destination's public URL once it has published. The page is taken most-recently-updated first, which is the feed's own order, so sort by scheduled_for yourself when you present a schedule. The answer is bounded: where the page held more posts than it could carry, it returns the first of them with truncated: true, posts_total and posts_returned, and next_cursor is non-null when more posts match the same filters than this page held at all. Use get_publish with an id for a post's whole record.",
    inputSchema: {
      status: z.array(agentPostFeedStatusSchema)
        .min(1)
        .max(agentPostFeedStatusSchema.options.length)
        .optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      account: z.string().min(1).max(255).optional(),
      // Twenty, not the route's fifty. This is a list a model reads inside one
      // bounded step, and a page it cannot record is worse than a shorter one:
      // the recorded step is refused whole at `result_too_large` and the turn
      // has nothing at all. Fifty is still reachable by asking for it.
      limit: z.number().int().min(1).max(50).default(20)
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    // Chat order 11, which `upload_media` vacated. Filling the gap renumbers
    // nothing: the two writes below keep 12 and 13, which is the whole reason
    // that removal left the number free rather than backfilling it.
    nativeChat: nativeChat(11, chatRead(/^\/v1\/posts$/)),
    run: async (client, { status, from, to, account, limit }) => {
      if (from && to && Date.parse(to) <= Date.parse(from)) {
        throw new PostdomToolRefusal("to must be after from");
      }
      return client.listPosts({ status, from, to, account, limit });
    }
  }),
  defineTool({
    name: "get_performance",
    title: "Get performance",
    // `window` is the schema's, so 90d arrived here the moment it
    // arrived on the wire rather than being retyped into a second enum that
    // could fall behind. The clamp is the API's, not this tool's: an agent asks
    // for a window and the workspace's plan decides how far back the read
    // actually reaches, which is why the description says to read `window` off
    // the answer instead of assuming the request was honoured.
    // The description says what the answer leaves out. An answer
    // that has been shortened and does not say so is worse than a long one:
    // `truncated` and `snapshots_total` are on the reply when it has been.
    // `account_id` now returns the ACCOUNT's own series beside the
    // post snapshots, so the two sentences added here are the ones an agent
    // needs to not misread it: `account_series` is the whole account including
    // posts Postdom never published, and `evidence: "documented"` says the
    // availability behind it rests on the provider's contract rather than on a
    // verified read. Kept to two sentences: the chat menu's fixed overhead is
    // measured against a 34 KiB bound and every description spends it.
    description: "Read normalized performance snapshots for one post or connected account. The workspace plan's history window applies: the reply's `window` is the window the read ran on, and `window_limit_days` is the furthest back this plan can reach. The most recent snapshots are returned, `limit` of them; where the window held more the reply carries truncated: true with snapshots_total. A metric with a value is a number on the row; a metric without one is absent from the row and named under `availability` with its state and the reason it has none. An absent metric is never a zero. With account_id the reply also carries `account_series`: the account's daily followers, reach, impressions and engagement with `totals`, the platform's own recent posts including ones Postdom did not publish, and `best_time` as provider guidance never applied to policy. Its `evidence` is \"documented\" until a row is verified against a live account.",
    inputSchema: {
      post_id: z.string().optional(),
      account_id: z.string().optional(),
      window: performanceWindowSchema.default("7d"),
      limit: z.number().int().min(1).max(PERFORMANCE_ROWS_MAX).default(PERFORMANCE_ROWS_DEFAULT)
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(8,
      chatRead(new RegExp(`^/v1/posts/${NATIVE_CHAT_OPAQUE}/performance$`)),
      chatRead(new RegExp(`^/v1/accounts/${NATIVE_CHAT_OPAQUE}/performance$`)),
    ),
    run: async (client, { post_id, account_id, window, limit }) => {
      if (Boolean(post_id) === Boolean(account_id)) {
        throw new PostdomToolRefusal("Provide exactly one of post_id or account_id");
      }
      return post_id
        ? client.getPostPerformance(post_id, limit)
        : client.getAccountPerformance(account_id!, window, limit);
    }
  }),
  defineTool({
    name: "get_best_posts",
    title: "Get best posts",
    description: "Rank one connected account's posts by an evidence-backed metric over the requested window. Null observations are excluded with reasons, never ranked as zero.",
    inputSchema: {
      account_id: z.string().min(1),
      metric: performanceMetricSchema,
      window: performanceWindowSchema.default("7d")
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(9, chatRead(new RegExp(`^/v1/accounts/${NATIVE_CHAT_OPAQUE}/best-posts$`))),
    run: async (client, { account_id, metric, window }) => client.getBestPosts(account_id, metric, window)
  }),
  defineTool({
    name: "create_slideshow",
    title: "Create branded slideshow",
    // Every byte here is charged against the native chat's per-turn admission bound (see
    // publish_video): the template list is the whole manual, in one line.
    description: "Render slides on the brand kit, one template a slide. cover(headline,kicker?,image_media_id?) text_image(headline,body,image_media_id?) list(items 3-5,title?) quote(quote,attribution) end_card(cta,handle) stat(stat,headline,body?) compare(left_label,right_label,left,right 2-4 rows,title?) checklist(items 3-6,title?) myth_fact(myth,fact) step(step,headline,body,image_media_id?) cover_image(headline,image_media_id,kicker?,body?). size 4:5/1:1 feed, 9:16 TikTok. Returns media_ids in order for publish_video media[]. Refusals name each field; fix all, retry. " + PLAYBOOK_ONE_LINE,
    inputSchema: {
      size: z.enum(SLIDESHOW_SIZES),
      /**
       * One flat object per slide rather than a union per template: the renderer's own schema
       * decides which fields a template takes and refuses the rest by name, and a union would
       * put five object schemas into a menu the chat pays for on every turn.
       */
      slides: z.array(z.object({
        template: z.enum(SLIDESHOW_TEMPLATES),
        headline: z.string().optional(),
        kicker: z.string().optional(),
        body: z.string().optional(),
        title: z.string().optional(),
        items: z.array(z.string()).optional(),
        quote: z.string().optional(),
        attribution: z.string().optional(),
        cta: z.string().optional(),
        handle: z.string().optional(),
        stat: z.string().optional(),
        left_label: z.string().optional(),
        right_label: z.string().optional(),
        left: z.array(z.string()).optional(),
        right: z.array(z.string()).optional(),
        myth: z.string().optional(),
        fact: z.string().optional(),
        step: z.number().int().positive().optional(),
        image_media_id: z.string().optional()
      })).min(1).max(SLIDESHOW_MAX_SLIDES),
      idempotency_key: z.string().min(1).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(19,
      chatWrite(/^\/v1\/slideshows$/),
      chatRead(new RegExp(`^/v1/slideshows/${NATIVE_CHAT_UUIDISH}$`))
    ),
    run: async (client, { size, slides, idempotency_key }) => {
      for (const slide of slides) {
        if (slide.image_media_id !== undefined) mediaHandleSchema.parse(slide.image_media_id);
      }
      // A refusal is an ANSWER, returned rather than thrown: every slide and field that did not
      // fit (or whose image is unusable), with a character hint, so the agent fixes all of them
      // in one retry. Thrown, the chat would record only "invalid_arguments" and the model
      // would never see which headline to shorten.
      const refused = (refusals: unknown, detail: string | null) => ({
        status: "refused",
        refusals,
        next: detail ?? "Shorten or fix every slide named in refusals, then call create_slideshow again with all the slides."
      });
      let result: SlideshowResponse & { idempotency_key: string };
      try {
        result = await client.createSlideshow({ size, slides, idempotencyKey: idempotency_key });
      } catch (error) {
        if (error instanceof PostdomApiError && error.code === "slides_do_not_fit") return refused(error.problem?.refusals ?? [], null);
        if (error instanceof PostdomApiError && error.code === "slide_image_invalid") return refused(error.problem?.errors ?? [], error.detail);
        throw error;
      }
      if (result.status === "refused") return refused(result.refusals, null);
      if (result.status === "failed") throw new PostdomToolRefusal(result.failure_reason ?? "The slides could not be rendered.");
      if (result.status === "rendering") {
        return {
          slideshow_id: result.slideshow_id,
          status: "rendering",
          idempotency_key: result.idempotency_key,
          next: "call create_slideshow again with the same size, slides and idempotency_key"
        };
      }
      return {
        slideshow_id: result.slideshow_id,
        status: result.status,
        size: result.size,
        kit_version: result.kit_version,
        media_ids: result.media.map((media) => media.media_id),
        media: result.media.map(({ media_id, position, template_id, preview_url }) => ({ media_id, position, template_id, preview_url })),
        notes: result.notes,
        next: "Pass media_ids in this order as publish_video media[].media_handle (a carousel), or reference them in a plan."
      };
    }
  })
];

export const POSTDOM_MCP_TOOL_NAMES: readonly string[] = POSTDOM_MCP_TOOLS.map((tool) => tool.name);

/** Every tool Postdom defines, on either surface.
 *
 * `POSTDOM_MCP_TOOLS` above is the agent menu: what
 * `createPostdomMcpServer` registers for a workspace key, and what postdom.com
 * counts. The rules tools in `./rules-tools` are not on it, and that is a
 * ruling rather than an omission: they write workspace rules through the
 * dashboard's own routes, which are human authority - an agent credential is
 * refused on every one of them by `isHumanAuthorityRoute` before the route
 * runs - so offering them over MCP would put a tool on the menu that no agent
 * could ever call, the failure `upload_media` was taken off the chat menu for.
 * They exist for Postdom Chat, which acts as the signed-in owner or admin.
 *
 * The chat derives its menu from this list, so a tool defined anywhere in the
 * package reaches the chat through the one `nativeChat` metadata rule. */
export const POSTDOM_TOOL_REGISTRY: readonly PostdomMcpToolDefinition[] = [
  ...POSTDOM_MCP_TOOLS,
  ...POSTDOM_CHAT_RULES_TOOLS,
  // The two schedule acts, on the same ruling as the rules tools
  // above: they write through `POST /v1/dashboard/posts/:id/resolve`, which
  // `isHumanAuthorityRoute` refuses every agent credential on, so an agent
  // could never call them. An agent cancels through `POST /v1/posts/:id/cancel`
  // with its own key, which is a different route with a different actor and is
  // not on this menu at all.
  ...POSTDOM_CHAT_SCHEDULE_TOOLS,
  // One chat that creates: `create_posts` opens a create card under the reply. It calls
  // no route, so an agent over MCP has nothing to gain from it and it is not on that menu.
  ...POSTDOM_CHAT_CREATE_TOOLS,
  // Registered here once; offered to an agent only when the server is built with
  // `autopilot: true` (see ./autopilot-tools), and never to the chat.
  ...POSTDOM_AUTOPILOT_TOOLS
];
export const POSTDOM_NATIVE_CHAT_TOOLS: readonly PostdomNativeChatToolDefinition[] =
  POSTDOM_TOOL_REGISTRY
    .filter((tool): tool is PostdomNativeChatToolDefinition => tool.nativeChat !== undefined)
    .sort((left, right) => left.nativeChat.order - right.nativeChat.order);

const oauthSecuritySchemesSchema = z.array(z.object({
  type: z.literal("oauth2"), scopes: z.array(z.enum(["read", "write"]))
}));
const chatGptToolSchema = ToolSchema.extend({ securitySchemes: oauthSecuritySchemesSchema });

function toolSecuritySchemes(tool: PostdomMcpToolDefinition) {
  // Scopes follow routes, not hints: account sync and media verification are read-scoped GETs.
  // create_slideshow POSTs the render and GETs it while the worker draws.
  const scopes = tool.name === "publish_video" || tool.name === "submit_plan" || tool.name === "create_slideshow" || tool.name === "generate_content"
    ? ["read", "write"]
    : tool.name === "connect_account" || tool.name === "upload_media" ? ["write"] : ["read"];
  return oauthSecuritySchemesSchema.parse([{ type: "oauth2", scopes }]);
}

/** `autopilot` adds the Autopilot tools (`generate_content`) to this server's menu. */
export interface PostdomMcpServerOptions {
  autopilot?: boolean;
}

export function createPostdomMcpServer(client: PostdomClient, serverOptions: PostdomMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "postdom", version: POSTDOM_MCP_VERSION });
  // The Autopilot tools join the menu only when asked for (see ./autopilot-tools).
  const menu = serverOptions.autopilot ? [...POSTDOM_MCP_TOOLS, ...POSTDOM_AUTOPILOT_TOOLS] : [...POSTDOM_MCP_TOOLS];
  const register = (tool: PostdomMcpToolDefinition) => {
    const securitySchemes = toolSecuritySchemes(tool);
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { ...tool.annotations },
        _meta: { securitySchemes }
      },
      async (input: unknown) => {
        try {
          return toolResult(await tool.run(client, input));
        } catch (error) {
          const allowance = allowanceToolError(error);
          if (allowance) return allowance;
          const challenge = client.oauthChallenge(error);
          if (!challenge) throw error;
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Reconnect Postdom with the required permissions." }],
            _meta: { "mcp/www_authenticate": [challenge] }
          };
        }
      }
    );
  };
  for (const tool of POSTDOM_MCP_TOOLS) register(tool);
  if (serverOptions.autopilot) for (const tool of POSTDOM_AUTOPILOT_TOOLS) register(tool);
  // Use the SDK's public Server API to retain ChatGPT's top-level extension.
  // Tool registration, execution and input validation remain with McpServer.
  const descriptors = menu.map((tool) => {
    const securitySchemes = toolSecuritySchemes(tool);
    return chatGptToolSchema.parse({
      name: tool.name, title: tool.title, description: tool.description,
      inputSchema: toJsonSchemaCompat(z.object(tool.inputSchema), { strictUnions: true, pipeStrategy: "input" }),
      annotations: { ...tool.annotations }, execution: { taskSupport: "forbidden" },
      securitySchemes, _meta: { securitySchemes }
    });
  });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: descriptors }));
  return server;
}

/**
 * Serve the same runtime used by the stdio CLI over stateless Streamable HTTP.
 * Authentication belongs to the hosting API and must run before this handler.
 */
export async function handlePostdomMcpHttpRequest(
  request: Request,
  options: PostdomClientOptions,
  serverOptions: PostdomMcpServerOptions = {}
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  const server = createPostdomMcpServer(new PostdomClient(options), serverOptions);
  await server.connect(transport);
  return transport.handleRequest(request);
}
