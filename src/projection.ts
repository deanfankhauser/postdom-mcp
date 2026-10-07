/**
 * The two facts every post projection states the same way, in one
 * file rather than in each of the files that state them.
 *
 * `list_posts` built both of these for the schedule it answers; the schedule
 * tools answer a card about one post and need exactly the same two. A second
 * copy of "enough of a caption to recognise the post" would be a second
 * opinion about how long that is, and a second copy of the run link would be a
 * second opinion about where a human reads what happened.
 */

/** The Postdom screen a run is read on. Absolute, because the reader is an
 * agent in someone else's process and a path alone names nothing there. Same
 * host `connect_account` already hands a human. */
export const POSTDOM_APP_ORIGIN = "https://app.postdom.com";

/** Enough of a caption to recognise the post, and no more.
 *
 * A caption is up to 4,000 characters and a list of twenty of them is the
 * whole of a recorded step's budget spent on text nobody asked for. Newlines
 * collapse because this is read as one field on one line, and the ellipsis is
 * the only honest way to show that what is here is not all of it. */
export const CAPTION_PREVIEW_MAX = 80;

export function captionPreview(value: unknown): string {
  if (typeof value !== "string") return "";
  const single = value.replace(/\s+/gu, " ").trim();
  return single.length > CAPTION_PREVIEW_MAX
    ? `${single.slice(0, CAPTION_PREVIEW_MAX - 1)}…`
    : single;
}

export const utf8Bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Where a human reads what happened to this post. Only ever built from an id
 * the API answered with. */
export const runUrl = (postId: string) => `${POSTDOM_APP_ORIGIN}/runs/${encodeURIComponent(postId)}`;
