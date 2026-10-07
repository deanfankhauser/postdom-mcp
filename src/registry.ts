import { z } from "zod";
import type { PostdomClient } from "./index";

/**
 * The registry's own vocabulary, in a file of its own.
 *
 * These lived in `index.ts` beside the tools that use them. The chat's rules
 * tools (`rules-tools.ts`) need the same `defineTool`, the same route helpers
 * and the same error classes, and `index.ts` needs the rules tools to build
 * the registry - a value import each way, which is a cycle that resolves in
 * whichever order the bundler happened to pick. Moving the vocabulary here
 * breaks it: both files import from this one, and this one imports only a
 * type from `index.ts`, which is erased before anything runs.
 *
 * Every export here is re-exported from `index.ts`, so nothing an agent, the
 * API or a test imports has moved.
 */

/** A tool refusing its own arguments, as opposed to a call that failed.
 *
 * Both reach an MCP agent as the same message text, so nothing changes there.
 * They are not the same fact, though, and a caller that has to record an
 * outcome needs to know which it got: a refusal is an answer, and an unreachable
 * API is a question still open. Reporting the second as the first would let a
 * model describe an outage as a finding. */
export class PostdomToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostdomToolRefusal";
  }
}

/** A failed API call with its problem document's structured fields intact.
 *
 * A later change added `detail`, and it is carried rather than re-derived for one
 * reason: a refusal a person reads should be the API's own sentence, not this
 * package's guess at what the API meant. `POST /v1/dashboard/posts/:id/resolve`
 * refuses a post that has already gone out in one sentence, and a tool that
 * rewrote it would be a second opinion about a fact only the route holds. It
 * is the problem document's `detail` and nothing else - never the constructed
 * message, which carries the status and the code with it. */
export class PostdomApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly destinations: readonly { platform: string; fact: string }[],
    readonly detail: string | null = null,
    /** The whole problem document, for a tool that answers from its structured
     * fields (create_slideshow's per-slide refusals). */
    readonly problem: Readonly<Record<string, unknown>> | null = null
  ) {
    super(message);
    this.name = "PostdomApiError";
  }
}

/** One tool definition, and only one.
 *
 * These used to be fourteen `server.registerTool` calls with their names,
 * descriptions, input schemas and annotations written inline. That was the only
 * copy while MCP was the only surface offering them. It is not any more: the
 * native chat offers the same tools to a model over the Responses API, and a
 * second hand-maintained list of names and descriptions is a divergence waiting
 * to happen - the same reason `PostdomPlatform` is derived from core rather than
 * restated at the top of `index.ts`.
 *
 * So the registry is the registration. `createPostdomMcpServer` walks it, and
 * any other Postdom surface reads the same entries instead of copying them.
 * `run` is the handler: it takes this package's own `PostdomClient`, never a
 * transport, so a caller that already holds a client does not need a JSON-RPC
 * session to invoke a tool. */
export type PostdomNativeChatRouteKind = "read" | "write" | "admin_write";
export interface PostdomNativeChatRoute {
  /** A later change added PUT: the workspace rules are written through the
   * compare-and-set contract, which is a PUT and nothing else. */
  readonly method: "GET" | "POST" | "PUT";
  /** Anchored, flag-free matcher for the exact API path the tool invokes. */
  readonly path: RegExp;
  /** The role boundary applied before the ordinary API route runs. */
  readonly kind: PostdomNativeChatRouteKind;
}
export interface PostdomNativeChatMetadata {
  /** Stable position in the model-facing tool menu. MCP registration has a
   * different public order, so deriving exposure must not silently reorder it. */
  readonly order: number;
  readonly routes: readonly PostdomNativeChatRoute[];
}

export interface PostdomMcpToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly openWorldHint: boolean;
  };
  /** Present only when Postdom Chat may offer this tool. The same entry owns
   * every internal API route and role that its handler can invoke, so adding a
   * tool cannot leave a stale capability route behind or forget the route it
   * needs. Ordinary API authorization still runs after this capability gate. */
  readonly nativeChat?: PostdomNativeChatMetadata;
  /** Arguments are parsed here as well as by whatever offered the schema. The
   * MCP SDK validates before it calls; a model's tool arguments have no such
   * guarantee, and this is the one place both callers share. */
  run(client: PostdomClient, input: unknown): Promise<Record<string, unknown>>;
}
export type PostdomNativeChatToolDefinition = PostdomMcpToolDefinition & {
  readonly nativeChat: PostdomNativeChatMetadata;
};

export function defineTool<Shape extends z.ZodRawShape>(definition: {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
  nativeChat?: PostdomNativeChatMetadata;
  run(client: PostdomClient, input: z.infer<z.ZodObject<Shape>>): Promise<Record<string, unknown>>;
}): PostdomMcpToolDefinition {
  const parser = z.object(definition.inputSchema);
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: definition.annotations,
    ...(definition.nativeChat ? { nativeChat: definition.nativeChat } : {}),
    run: (client, input) => definition.run(client, parser.parse(input ?? {}))
  };
}

export const chatRead = (path: RegExp): PostdomNativeChatRoute => ({ method: "GET", path, kind: "read" });
export const chatWrite = (path: RegExp): PostdomNativeChatRoute => ({ method: "POST", path, kind: "write" });
export const chatAdminWrite = (path: RegExp, method: "POST" | "PUT" = "POST"): PostdomNativeChatRoute =>
  ({ method, path, kind: "admin_write" });
export const nativeChat = (order: number, ...routes: PostdomNativeChatRoute[]): PostdomNativeChatMetadata => ({ order, routes });
// These are the existing capability bounds, moved intact from the API's
// second route list. `opaque` accepts the same non-slash path component and
// plan reads retain the same UUID-shaped matcher.
export const NATIVE_CHAT_UUIDISH = "[0-9a-fA-F-]{1,64}";
export const NATIVE_CHAT_OPAQUE = "[^/]{1,256}";
