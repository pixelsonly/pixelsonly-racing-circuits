/**
 * Wikimedia Commons helpers shared by the asset-fetch scripts (fetch-flag,
 * fetch-map). Each fetcher needs the same two things: a canonical file URL
 * to download from, and the file's license/attribution metadata for the
 * LICENSE-ASSETS.md register. Both come from the Commons MediaWiki API's
 * imageinfo endpoint.
 */

import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";

export const USER_AGENT =
  "pixelsonly-racing-circuits/0.1.0 (https://github.com/pixelsonly/pixelsonly-racing-circuits)";

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

/**
 * Look up a Commons file's canonical URL + extmetadata (license, artist, etc).
 * `title` should be the full "File:Name.svg" form. Throws on miss.
 */
export async function commonsImageInfo(title) {
  const url = new URL(COMMONS_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|extmetadata");
  url.searchParams.set("titles", title);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("redirects", "1");
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Commons API failed: HTTP ${res.status}`);
  const json = await res.json();
  const page = json?.query?.pages?.[0];
  if (!page || page.missing || !page.imageinfo?.[0]) {
    throw new Error(`Commons did not return imageinfo for ${title}.`);
  }
  return page.imageinfo[0];
}

export function commonsFilePageUrl(title) {
  return `https://commons.wikimedia.org/wiki/${encodeURI(title.replace(/ /g, "_"))}`;
}

/**
 * Normalize a user-supplied --from value into a "File:Name.svg" title.
 * Accepts: a bare filename, a "File:..." title, or a Commons URL
 * (https://commons.wikimedia.org/wiki/File:...
 *  or .../wikipedia/commons/.../Name.svg via redirect).
 */
export function normalizeCommonsTitle(input) {
  const s = String(input).trim();
  if (!s) throw new Error("Empty --from value.");
  if (/^https?:\/\//i.test(s)) {
    const url = new URL(s);
    const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
    if (!last) throw new Error(`Could not derive a filename from ${s}.`);
    return last.startsWith("File:") ? last : `File:${last.replace(/^File:/i, "")}`;
  }
  return s.startsWith("File:") ? s : `File:${s}`;
}

export function stripHtml(html) {
  return String(html).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

export function stripTrailingPunctuation(s) {
  return String(s).replace(/[.\s]+$/, "");
}

export function escapePipe(s) {
  return String(s).replace(/\|/g, "\\|");
}

export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function readTrackRecord(yamlPath) {
  const text = await readFile(yamlPath, "utf8");
  return parseYaml(text);
}
