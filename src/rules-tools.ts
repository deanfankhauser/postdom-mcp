import { z } from "zod";
import {
  askingSentence,
  brandNotesChange,
  conditionalDefaultsSnapshotSchema,
  corePlatformSchema,
  applyPromptEdit,
  briefPromptValues,
  hasLoneCarriageReturn,
  platformLabel,
  rulesChange,
  rulesSnapshot,
  type BrandNotesField,
  type BriefPromptKey,
  type ConditionalDefaultsSnapshot,
  type CorePlatform,
  type RulesChangeScope,
  type RulesSnapshot
} from "@postdom/core";
import type { PostdomClient } from "./index";
import {
  PostdomApiError,
  PostdomToolRefusal,
  chatAdminWrite,
  chatRead,
  defineTool,
  nativeChat,
  type PostdomMcpToolDefinition
} from "./registry";

/**
 * Chat can set rules.
 *
 * Three tools that change what the Rules page shows, through the routes the
 * Rules page itself writes with, so nothing here is a second way to change a
 * rule: `PUT /v1/dashboard/policies/workspace-defaults/conditional` for the
 * workspace's own rules (a compare-and-set on the saved version), `POST
 * /v1/dashboard/accounts/trust`, `/accounts/pause` and `/policies` for one
 * account's exception, `POST /v1/dashboard/pause` for the brake, and `POST
 * /v1/dashboard/brief` with `base_version` for the two brief sections.
 *
 * Human authority, deliberately. Every route above is one `isHumanAuthorityRoute`
 * refuses an agent credential on, so these tools are not on the MCP menu an
 * agent key sees (`POSTDOM_MCP_TOOLS` in index.ts) - a tool an agent could
 * never call is the failure `upload_media` was taken off the chat menu for.
 * They exist for Postdom Chat, whose capability carries the signed-in member's
 * own role: an owner, admin or member writes (members have
 * the same rights as owners and admins except changing the plan).
 *
 * Every answer is the card `@postdom/core` defines (`rulesChangeSchema`): the
 * rules before, the rules after, which fields moved, and - when nothing was
 * saved - why, in one sentence the chat says as written. `after` is read back
 * from the API after the write, never assumed from the request.
 */

const quietTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "HH:MM on the workspace clock");

/** The resolved policy `GET /v1/dashboard/policies` answers for one account.
 * Read with the fields this file needs and nothing dropped: a field the route
 * adds tomorrow must not take a rules change down. */
const resolvedPolicySchema = z.looseObject({
  accountId: z.string().min(1),
  maximumPostsPerDay: z.number().int(),
  allowedVisibilities: z.array(z.string()),
  quietHoursStart: z.string().nullable(),
  quietHoursEnd: z.string().nullable(),
  trustLevel: z.number().int(),
  paused: z.boolean(),
  /** Which of the resolved values are the account's own decision rather than
   * the workspace's, as `GET /v1/dashboard/policies` reports them. Read
   * because a per-account write has to put back what it did not change - see
   * "answer one, keep the rest" in `set_posting_limits`. */
  overrides: z.looseObject({
    trustLevel: z.boolean().optional(),
    maximumPostsPerDay: z.boolean().optional(),
    quietHours: z.boolean().optional(),
    allowedVisibilities: z.boolean().optional()
  }).optional()
});
type ResolvedPolicy = z.infer<typeof resolvedPolicySchema>;

const policiesSchema = z.looseObject({
  workspace_defaults: z.looseObject({ timezone: z.string().min(1) }),
  policies: z.array(z.unknown())
});

const brakeSchema = z.looseObject({ agent_paused: z.boolean() });
/** The workspace's accounts as `GET /v1/workspace/status` answers them - the
 * store's own rows, never the provider's listing. `GET /v1/accounts` would
 * have been the obvious read and is the wrong one: it syncs with the
 * provider, so a rule change would depend on a supplier being up. */
const workspaceStatusSchema = z.looseObject({
  accounts: z.array(z.looseObject({
    account_id: z.string().min(1),
    platform: z.string(),
    handle: z.string().nullable().optional()
  }))
});
type WorkspaceAccount = { account_id: string; platform: CorePlatform; handle: string | null };
const briefSchema = z.looseObject({
  current: z.looseObject({ version: z.number().int().positive(), content: z.string() })
});
const savedBriefSchema = z.looseObject({ version: z.number().int().positive(), content: z.string() });

const readPolicies = async (client: PostdomClient) => {
  const answer = policiesSchema.parse(await client.request("/dashboard/policies"));
  // An account row this build cannot read is left out rather than guessed at;
  // a tool aimed at it then refuses by name below.
  const policies = answer.policies.flatMap((row) => {
    const parsed = resolvedPolicySchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  return { timezone: answer.workspace_defaults.timezone, policies };
};
const readConditional = async (client: PostdomClient): Promise<ConditionalDefaultsSnapshot> =>
  conditionalDefaultsSnapshotSchema.parse(await client.request("/dashboard/policies/workspace-defaults/conditional"));
const readBrake = async (client: PostdomClient) =>
  brakeSchema.parse(await client.request("/dashboard/status")).agent_paused;
/** Every account the workspace has, on a destination this build models. One
 * it does not model is left out rather than described, so a tool aimed at it
 * refuses by name below. */
const readWorkspaceAccounts = async (client: PostdomClient): Promise<WorkspaceAccount[]> =>
  workspaceStatusSchema.parse(await client.request("/workspace/status")).accounts.flatMap((row) => {
    const platform = corePlatformSchema.safeParse(row.platform);
    return platform.success ? [{ account_id: row.account_id, platform: platform.data, handle: row.handle ?? null }] : [];
  });
const readBrief = async (client: PostdomClient) =>
  briefSchema.parse(await client.request("/dashboard/brief")).current;

const post = (client: PostdomClient, path: string, body: unknown) =>
  client.request<Record<string, unknown>>(path, { method: "POST", body: JSON.stringify(body) });

const apiStatus = (error: unknown, status: number, code?: string) =>
  error instanceof PostdomApiError && error.status === status && (code === undefined || error.code === code);

const workspaceSnapshot = (defaults: ConditionalDefaultsSnapshot["defaults"], brake: boolean): RulesSnapshot =>
  rulesSnapshot({
    askingLevel: defaults.trustLevel,
    paused: brake,
    postsPerDay: defaults.maximumPostsPerDay,
    quietHoursStart: defaults.quietHoursStart,
    quietHoursEnd: defaults.quietHoursEnd
  });

const accountSnapshot = (resolved: ResolvedPolicy): RulesSnapshot =>
  rulesSnapshot({
    askingLevel: resolved.trustLevel,
    paused: resolved.paused,
    postsPerDay: resolved.maximumPostsPerDay,
    quietHoursStart: resolved.quietHoursStart,
    quietHoursEnd: resolved.quietHoursEnd
  });

/** The one account a per-account change is about, from the workspace's own
 * rows. An id the workspace does not have is refused here by name, before any
 * read of policy. */
async function namedAccount(client: PostdomClient, accountId: string): Promise<WorkspaceAccount> {
  const account = (await readWorkspaceAccounts(client)).find((row) => row.account_id === accountId);
  if (!account) throw new PostdomToolRefusal(`No connected account has the id ${accountId}`);
  return account;
}

const accountScope = (account: WorkspaceAccount): RulesChangeScope => ({
  kind: "account",
  account_id: account.account_id,
  platform: account.platform,
  handle: account.handle
});

const accountName = (platform: CorePlatform, handle: string | null | undefined) =>
  handle ? `${platformLabel(platform)} @${handle}` : platformLabel(platform);

async function resolvedFor(client: PostdomClient, accountId: string) {
  const { timezone, policies } = await readPolicies(client);
  const resolved = policies.find((row) => row.accountId === accountId);
  if (!resolved) throw new PostdomToolRefusal(`No policy could be read for account ${accountId}`);
  return { timezone, resolved };
}

/** The workspace's rules, written the way the Rules page writes them.
 *
 * Read the saved version, write with `expected_version`, and on a 412 read
 * again and write once more against what is there now. A second 412 is
 * reported as a conflict with the latest saved rules attached, never as a
 * success and never as a silent third try: two writes is the whole allowance,
 * and the card says which of the two outcomes it is. */
async function writeWorkspaceDefaults(
  client: PostdomClient,
  patch: Partial<{
    trust_level: number;
    paused: boolean;
    maximum_posts_per_day: number;
    quiet_hours_start: string | null;
    quiet_hours_end: string | null;
  }>
): Promise<{ snapshot: ConditionalDefaultsSnapshot; conflict: boolean }> {
  let current = await readConditional(client);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const defaults = current.defaults;
    const body = {
      trust_level: defaults.trustLevel,
      paused: defaults.paused,
      timezone: defaults.timezone,
      maximum_posts_per_day: defaults.maximumPostsPerDay,
      quiet_hours_start: defaults.quietHoursStart,
      quiet_hours_end: defaults.quietHoursEnd,
      ...patch,
      expected_version: current.persisted_version,
      expected_org_id: current.org_id
    };
    try {
      const written = await client.request("/dashboard/policies/workspace-defaults/conditional", {
        method: "PUT",
        body: JSON.stringify(body)
      });
      return { snapshot: conditionalDefaultsSnapshotSchema.parse(written), conflict: false };
    } catch (error) {
      if (!apiStatus(error, 412)) throw error;
      current = await readConditional(client);
    }
  }
  return { snapshot: current, conflict: true };
}

const CONFLICT = {
  code: "policy_version_conflict",
  detail: "Someone else changed the rules just now, so nothing was saved. This is the latest."
};

const RULES_ROUTES = {
  policies: chatRead(/^\/v1\/dashboard\/policies$/),
  conditional: chatRead(/^\/v1\/dashboard\/policies\/workspace-defaults\/conditional$/),
  brake: chatRead(/^\/v1\/dashboard\/status$/),
  accounts: chatRead(/^\/v1\/workspace\/status$/),
  putConditional: chatAdminWrite(/^\/v1\/dashboard\/policies\/workspace-defaults\/conditional$/, "PUT"),
  pause: chatAdminWrite(/^\/v1\/dashboard\/pause$/),
  accountTrust: chatAdminWrite(/^\/v1\/dashboard\/accounts\/trust$/),
  accountPause: chatAdminWrite(/^\/v1\/dashboard\/accounts\/pause$/),
  accountPolicy: chatAdminWrite(/^\/v1\/dashboard\/policies$/),
  accountInherit: chatAdminWrite(/^\/v1\/dashboard\/policies\/inherit$/),
  brief: chatRead(/^\/v1\/dashboard\/brief$/),
  saveBrief: chatAdminWrite(/^\/v1\/dashboard\/brief$/)
};

/** The six writing rules `set_brand_notes` writes: the argument, the brief prompt, the
 * section's own name in a refusal. In the card's field order. */
const BRAND_NOTES_SECTIONS: ReadonlyArray<{ field: BrandNotesField; key: BriefPromptKey; label: string }> = [
  { field: "voice", key: "voice", label: "Voice" },
  { field: "never_do", key: "never", label: "Never do" },
  { field: "captions", key: "captions", label: "Captions" },
  { field: "hashtags", key: "hashtags", label: "Hashtags" },
  { field: "platform_notes", key: "platforms", label: "Per-platform notes" },
  { field: "timing", key: "timing", label: "Timing preferences" }
];

export const POSTDOM_CHAT_RULES_TOOLS: readonly PostdomMcpToolDefinition[] = [
  defineTool({
    name: "set_approval_rule",
    title: "Set approval rule",
    description: "Change when Postdom asks the person before posting, or pause posting, for the whole workspace or for one connected account. asking_level: 0 You schedule everything yourself · 1 Ask me before every post · 2 Ask me once per plan · 3 Post without asking. Omit account_id for the workspace; give an account's id from the facts block for that account only. Level 3 needs a bounded policy on the account - a daily limit and at least one allowed visibility - and when that is missing the answer says what is missing with applied: false rather than changing anything. Writes through the same versioned rules the Rules page uses and answers a before → after card: report the card's before, after and summary, never a predicted outcome. Call only when the person asked for this change in this message.",
    inputSchema: {
      account_id: z.string().min(1).max(255).optional(),
      asking_level: z.number().int().min(0).max(3).optional(),
      paused: z.boolean().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(14,
      RULES_ROUTES.policies, RULES_ROUTES.conditional, RULES_ROUTES.brake, RULES_ROUTES.accounts,
      RULES_ROUTES.putConditional, RULES_ROUTES.pause, RULES_ROUTES.accountTrust, RULES_ROUTES.accountPause),
    run: async (client, { account_id, asking_level, paused }) => {
      if (asking_level === undefined && paused === undefined) {
        throw new PostdomToolRefusal("Give asking_level, paused or both");
      }
      if (account_id !== undefined) {
        const account = await namedAccount(client, account_id);
        const { timezone, resolved } = await resolvedFor(client, account_id);
        const before = accountSnapshot(resolved);
        let blocked: { code: string; detail: string } | null = null;
        if (asking_level !== undefined && asking_level !== before.asking_level) {
          try {
            await post(client, "/dashboard/accounts/trust", { account_id, trust_level: asking_level });
          } catch (error) {
            if (!apiStatus(error, 409, "policy_required")) throw error;
            // The gate, said as what is missing. The store refuses level 3
            // when the effective policy allows no visibility (a cap below one
            // cannot be saved), so that is the one thing this can name.
            blocked = {
              code: "policy_required",
              detail: `Post without asking needs a daily limit and at least one allowed visibility on ${accountName(account.platform, account.handle)}, and right now no visibility is allowed on it.`
            };
          }
        }
        if (blocked === null && paused !== undefined && paused !== before.paused) {
          await post(client, "/dashboard/accounts/pause", { account_id, paused });
        }
        const after = accountSnapshot((await resolvedFor(client, account_id)).resolved);
        return rulesChange({ scope: accountScope(account), before, after, applied: blocked === null, timezone, blocked });
      }
      const [conditional, brake, { timezone, policies }, accounts] = await Promise.all([
        readConditional(client), readBrake(client), readPolicies(client), readWorkspaceAccounts(client)
      ]);
      const before = workspaceSnapshot(conditional.defaults, brake);
      let blocked: { code: string; detail: string } | null = null;
      if (asking_level !== undefined && asking_level !== before.asking_level) {
        const written = await writeWorkspaceDefaults(client, { trust_level: asking_level });
        if (written.conflict) blocked = CONFLICT;
      }
      if (blocked === null && paused !== undefined && paused !== brake) {
        await post(client, "/dashboard/pause", { paused });
      }
      const [latest, latestBrake] = await Promise.all([readConditional(client), readBrake(client)]);
      const after = workspaceSnapshot(latest.defaults, latestBrake);
      // Accounts that keep their own asking level, so the card never claims a
      // workspace rule over an exception the workspace has.
      const byId = new Map(accounts.map((row) => [row.account_id, row]));
      const exceptions = policies.flatMap((row) => {
        if (row.overrides?.trustLevel !== true || row.trustLevel === after.asking_level) return [];
        const account = byId.get(row.accountId);
        if (!account) return [];
        return [{
          account_id: row.accountId,
          platform: account.platform,
          handle: account.handle,
          asking_level: row.trustLevel as 0 | 1 | 2 | 3,
          asking: askingSentence(row.trustLevel)
        }];
      });
      return rulesChange({ scope: { kind: "workspace" }, before, after, applied: blocked === null, timezone, blocked, exceptions });
    }
  }),
  defineTool({
    name: "set_posting_limits",
    title: "Set posting limits",
    description: "Set how many posts a day Postdom may make (posts_per_day, 1 to 100) and the quiet hours in which nothing goes out (quiet_hours as a start and end in HH:MM on the workspace clock, or quiet_hours_off: true for none), for the whole workspace or for one connected account. Omit account_id for the workspace. A day of the week is not a rule the product has, so never promise one. Writes through the same versioned rules the Rules page uses and answers a before → after card: report the card's before, after and summary, never a predicted outcome. Call only when the person asked for this change in this message.",
    inputSchema: {
      account_id: z.string().min(1).max(255).optional(),
      posts_per_day: z.number().int().min(1).max(100).optional(),
      quiet_hours: z.object({ start: quietTime, end: quietTime }).optional(),
      quiet_hours_off: z.boolean().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(15,
      RULES_ROUTES.policies, RULES_ROUTES.conditional, RULES_ROUTES.brake, RULES_ROUTES.accounts,
      RULES_ROUTES.putConditional, RULES_ROUTES.accountPolicy, RULES_ROUTES.accountInherit),
    run: async (client, { account_id, posts_per_day, quiet_hours, quiet_hours_off }) => {
      if (posts_per_day === undefined && quiet_hours === undefined && !quiet_hours_off) {
        throw new PostdomToolRefusal("Give posts_per_day, quiet_hours or quiet_hours_off");
      }
      if (quiet_hours !== undefined && quiet_hours_off) {
        throw new PostdomToolRefusal("quiet_hours and quiet_hours_off cannot both be given");
      }
      const quiet = quiet_hours_off
        ? { start: null, end: null }
        : quiet_hours
          ? { start: quiet_hours.start, end: quiet_hours.end }
          : undefined;
      if (account_id !== undefined) {
        const account = await namedAccount(client, account_id);
        const { timezone, resolved } = await resolvedFor(client, account_id);
        const before = accountSnapshot(resolved);
        let blocked: { code: string; detail: string } | null = null;
        if (resolved.allowedVisibilities.length === 0) {
          // The per-account write carries the whole exception - cap, quiet
          // hours and allowed visibilities together - and the route refuses an
          // empty visibility list. Said here rather than surfaced as a 400.
          blocked = {
            code: "invalid_visibility",
            detail: `${accountName(account.platform, account.handle)} allows no visibility, so its limits cannot be saved on their own; add an allowed visibility on the Rules page first.`
          };
        } else {
          await post(client, "/dashboard/policies", {
            account_id,
            maximum_posts_per_day: posts_per_day ?? resolved.maximumPostsPerDay,
            allowed_visibilities: resolved.allowedVisibilities,
            quiet_hours_start: quiet ? quiet.start : resolved.quietHoursStart,
            quiet_hours_end: quiet ? quiet.end : resolved.quietHoursEnd
          });
          // Answer one, keep the rest.
          //
          // The write above is the whole exception in one body - the cap, the
          // quiet hours and the allowed visibilities together - because that is
          // the contract the Rules page writes. Sending the resolved value for
          // a field the person did not mention does keep the value, and pins
          // it: the account stops following the workspace on that field, so
          // "5 a day on LinkedIn" quietly froze LinkedIn's quiet hours and its
          // allowed visibilities at whatever the workspace happened to say
          // that afternoon, and a later workspace change no longer reached it.
          //
          // So every field this call did not name, and which the account was
          // not already overriding, is handed back to the workspace right
          // after the write. The values do not move; what is restored is where
          // they are read from.
          const keep = [
            ...(posts_per_day === undefined && resolved.overrides?.maximumPostsPerDay !== true ? ["maximumPostsPerDay"] : []),
            ...(quiet === undefined && resolved.overrides?.quietHours !== true ? ["quietHours"] : []),
            // Never named by this tool at all: the visibilities travel on the
            // body because the route requires them, never because the person
            // asked for them.
            ...(resolved.overrides?.allowedVisibilities !== true ? ["allowedVisibilities"] : [])
          ];
          //
          // A hand-back that fails is not a change that failed. The limit the
          // person asked for is saved, and answering a landed write with a
          // refusal is the exact fault this check is about; what a failed
          // hand-back leaves behind is a pinned field, which the Rules page
          // hands back in one click. The card states the values either way,
          // and it reads them back from the API rather than assuming them.
          if (keep.length > 0) {
            await post(client, "/dashboard/policies/inherit", { account_id, fields: keep }).catch(() => undefined);
          }
        }
        const after = accountSnapshot((await resolvedFor(client, account_id)).resolved);
        return rulesChange({ scope: accountScope(account), before, after, applied: blocked === null, timezone, blocked });
      }
      const [conditional, brake] = await Promise.all([readConditional(client), readBrake(client)]);
      const before = workspaceSnapshot(conditional.defaults, brake);
      const written = await writeWorkspaceDefaults(client, {
        ...(posts_per_day !== undefined ? { maximum_posts_per_day: posts_per_day } : {}),
        ...(quiet ? { quiet_hours_start: quiet.start, quiet_hours_end: quiet.end } : {})
      });
      const after = workspaceSnapshot(written.snapshot.defaults, brake);
      return rulesChange({
        scope: { kind: "workspace" },
        before,
        after,
        applied: !written.conflict,
        timezone: written.snapshot.defaults.timezone,
        blocked: written.conflict ? CONFLICT : null
      });
    }
  }),
  defineTool({
    name: "set_brand_notes",
    title: "Set brand notes",
    description: "Rewrite one or more of the six writing rules in the workspace brief, in the person's words: voice (Voice), never_do (Never do), captions (Captions), hashtags (Hashtags), platform_notes (Per-platform notes; may use one `## Instagram`-style subheading per platform) and timing (Timing preferences). Every section not sent is left exactly as it is. Send the whole new text of a section, not an addition to it. Saved as a new brief version against the current one, the same way the Rules page saves it, and answers a before → after card: report the card's summary and the new text, never a predicted outcome. Call only when the person asked for this change in this message.",
    inputSchema: {
      voice: z.string().trim().min(1).max(4_000).optional(),
      never_do: z.string().trim().min(1).max(4_000).optional(),
      captions: z.string().trim().min(1).max(4_000).optional(),
      hashtags: z.string().trim().min(1).max(4_000).optional(),
      platform_notes: z.string().trim().min(1).max(4_000).optional(),
      timing: z.string().trim().min(1).max(4_000).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    nativeChat: nativeChat(16, RULES_ROUTES.brief, RULES_ROUTES.saveBrief),
    run: async (client, args) => {
      const sent = BRAND_NOTES_SECTIONS.filter((section) => args[section.field] !== undefined);
      if (sent.length === 0) {
        throw new PostdomToolRefusal("Give at least one of voice, never_do, captions, hashtags, platform_notes or timing");
      }
      // A heading line inside a section is refused,
      // before the document is read at all.
      //
      // The brief is one markdown document split on its `# ` lines, so a
      // section body carrying one does not stay in its section: the review sent
      // a Voice that began with an H1 and the parse that read it back moved
      // Captions, Hashtags, Timing preferences and Never do into it. The
      // person's own brief was rewritten around a line the model wrote. There
      // is no safe way to save it and no reason to guess at what was meant, so
      // nothing is written and the arguments are refused. Per-platform
      // notes holds one `## Platform` subheading per platform, so that section
      // alone may carry `## ` lines - never an H1, and never a deeper heading.
      for (const section of sent) {
        const label = section.label;
        const text = args[section.field]!;
        // A heading is one or more # then a space (or nothing): "#lisbon #goldenvisa" is a hashtag
        // line, which the Hashtags section exists to hold, and the brief's parse never splits on it.
        const heading = text.split(/\r\n|\r|\n/).find((line) => /^#+(\s|$)/.test(line)
          &&!(section.field === "platform_notes" && /^## (?!#)\S/.test(line)));
        if (heading !== undefined) {
          throw new PostdomToolRefusal(
            `The ${label} section cannot contain a heading line (${heading.trim().slice(0, 80)}); send the section's own words`
          );
        }
        // A carriage return with no newline after it.
        // The parse ends a line on one and so does a browser's textarea, which
        // then submits the same text with CRLF - at which point a line this
        // section was holding becomes a heading and tears the document. The
        // section is refused rather than stored with two possible meanings.
        if (hasLoneCarriageReturn(text)) {
          throw new PostdomToolRefusal(
            `The ${label} section cannot contain a bare carriage return; send it as plain lines`
          );
        }
      }
      let current = await readBrief(client);
      const notes = (content: string) => {
        const values = briefPromptValues(content);
        return Object.fromEntries(BRAND_NOTES_SECTIONS.map((section) => [section.field, values[section.key]])) as Record<BrandNotesField, string>;
      };
      const before = notes(current.content);
      // The edited ranges and nothing else: the same range edit the Rules page
      // writes with (`applyPromptEdit`), so every section this call does not
      // name - and any section this build does not structure - is the bytes it was.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const content = sent.reduce((document, section) => applyPromptEdit(document, section.key, args[section.field]!), current.content);
        try {
          const saved = savedBriefSchema.parse(await post(client, "/dashboard/brief", {
            content,
            base_version: current.version
          }));
          return brandNotesChange({ before, after: notes(saved.content), applied: true, version: saved.version });
        } catch (error) {
          if (!apiStatus(error, 409, "brief_version_conflict")) throw error;
          current = await readBrief(client);
        }
      }
      return brandNotesChange({
        before,
        after: notes(current.content),
        applied: false,
        version: null,
        blocked: { code: "brief_version_conflict", detail: "Someone else saved the brief just now, so nothing was written. This is the latest." }
      });
    }
  })
];

export const POSTDOM_CHAT_RULES_TOOL_NAMES: readonly string[] = POSTDOM_CHAT_RULES_TOOLS.map((tool) => tool.name);
