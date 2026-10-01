import type { Proposal } from "../types";

/**
 * Where the API lives. In production this is "/api" — a path on the site's own
 * domain, which CloudFront forwards to the Lambda. Same origin as the page, so
 * no CORS is involved anywhere in this file.
 */
const RAW = import.meta.env.VITE_API_URL as string | undefined;
export const API = RAW ? RAW.replace(/\/$/, "") : undefined;

/**
 * The API as a full URL. The archivist's take-down links travel by email, so
 * they cannot be relative — but everything the browser does uses `API`.
 */
function absoluteApi(): string | undefined {
  if (!API) return undefined;
  if (/^https?:\/\//.test(API)) return API;
  return typeof window === "undefined"
    ? API
    : `${window.location.origin}${API}`;
}
export const ADMIN_EMAIL = import.meta.env.VITE_ADMIN_EMAIL as
  | string
  | undefined;

/**
 * POST through CloudFront to the Lambda origin.
 *
 * CloudFront signs each request to the function URL with SigV4 on our behalf,
 * and Lambda will not accept an unsigned payload — so the caller has to supply
 * the SHA-256 of the body in `x-amz-content-sha256`. Without it the origin
 * answers 403 and nothing reaches the function at all. AWS documents this as a
 * requirement of using origin access control with a function URL:
 *
 *   "If you use PUT or POST methods with your Lambda function URL, your users
 *    must compute the SHA256 of the body and include the payload hash value of
 *    the request body in the x-amz-content-sha256 header."
 */
async function postJson(path: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  // crypto.subtle needs a secure context. The site is HTTPS; plain-http local
  // development falls back to sending it unhashed, which only matters when
  // talking to a real CloudFront origin.
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body),
    );
    headers["x-amz-content-sha256"] = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  return fetch(`${API}${path}`, { method: "POST", headers, body });
}

/** True once the AWS side is deployed and `.env` points at it. */
export const hasBackend = Boolean(API);

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export class SubmitError extends Error {}

const PASSCODE_KEY = "deguise-passcode";

/** The family passcode, remembered per browser so it is typed once. */
export function readPasscode(): string {
  try {
    return localStorage.getItem(PASSCODE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberPasscode(code: string) {
  try {
    localStorage.setItem(PASSCODE_KEY, code);
  } catch {
    // A browser that will not store it just asks again next time.
  }
}

export interface LivePhoto {
  id: string;
  personId: string;
  src: string;
  caption?: string;
  by?: string;
  at?: string;
}

export interface LiveStory {
  id: string;
  personId: string;
  text: string;
  by?: string;
  at?: string;
}

export interface Overlay {
  photos: LivePhoto[];
  stories: LiveStory[];
}

const EMPTY: Overlay = { photos: [], stories: [] };

/**
 * Everything the family has published since the last deploy. Written by the
 * API straight into the site bucket, so it appears for everyone without
 * rebuilding the site.
 */
export async function fetchOverlay(): Promise<Overlay> {
  try {
    const res = await fetch(`/gallery.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return EMPTY;
    const data = (await res.json()) as Partial<Overlay>;
    return {
      photos: Array.isArray(data.photos) ? data.photos : [],
      stories: Array.isArray(data.stories) ? data.stories : [],
    };
  } catch {
    // No overlay yet, or offline. The tree still works.
    return EMPTY;
  }
}

/**
 * Ask the API for a presigned PUT, then upload the file straight to S3 so the
 * bytes never pass through the Lambda.
 */
async function uploadPhoto(
  file: File,
  passcode: string,
): Promise<{ key: string; publicPath: string }> {
  const res = await postJson("/upload-url", {
    fileName: file.name,
    fileType: file.type,
    passcode,
  });
  if (res.status === 401) {
    throw new SubmitError("That family passcode is not right.");
  }
  if (!res.ok) throw new SubmitError(`Could not start the upload (${res.status})`);
  const { url, key, publicPath } = (await res.json()) as {
    url: string;
    key: string;
    publicPath: string;
  };

  const put = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!put.ok) throw new SubmitError(`The upload failed (${put.status})`);
  return { key, publicPath };
}

/**
 * Send a proposal to the archivist. Photographs and life stories sent with the
 * family passcode go live immediately; `live` in the result says whether this
 * one did.
 *
 * With no backend configured the call resolves quietly: the caller has already
 * shown the contribution in the page, and `hasBackend` tells the UI to say the
 * archive is in preview rather than pretending the message was sent.
 */
export async function submitProposal(
  proposal: Proposal,
  file?: File,
  passcode = "",
): Promise<{ publicPath?: string; live?: boolean }> {
  if (!API) return {};

  let payload = proposal;
  let publicPath: string | undefined;

  if (proposal.kind === "photo" && file) {
    const up = await uploadPhoto(file, passcode);
    publicPath = up.publicPath;
    payload = {
      ...proposal,
      storageKey: up.key,
      publicPath: up.publicPath,
      passcode,
      apiBase: absoluteApi(),
    } as Proposal;
  }

  if (proposal.kind === "biography") {
    payload = { ...proposal, passcode, apiBase: absoluteApi() } as Proposal;
  }

  const res = await postJson("/proposals", payload);
  if (res.status === 401) {
    throw new SubmitError("That family passcode is not right.");
  }
  if (!res.ok) {
    throw new SubmitError(
      res.status === 429
        ? "That is a lot of contributions at once — try again in a minute."
        : `The archivist's inbox did not accept it (${res.status})`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as { live?: boolean };
  return { publicPath, live: body.live };
}

/**
 * Take a published photograph off the tree for good: the row is marked
 * removed, the file is deleted from storage, and the gallery is rebuilt
 * without it. Only photographs the family published can go this way —
 * anything in tree.json is part of the deployed record.
 */
export async function deletePhoto(id: string, passcode: string): Promise<void> {
  if (!API) return;
  const res = await postJson("/delete-photo", { id, passcode });
  if (res.status === 401) {
    throw new SubmitError("That family passcode is not right.");
  }
  if (!res.ok) {
    throw new SubmitError(`Could not remove it (${res.status})`);
  }
}

/* ------------------------------------------------------ looking them up --- */

interface Searchable {
  name: string;
  nee?: string;
  born?: string;
  died?: string;
  bornPlace?: string;
  diedPlace?: string;
}

const year = (s?: string) => /\b(1[6-9]\d\d|20\d\d)\b/.exec(s ?? "")?.[1];

/**
 * Trove only digitises newspapers up to the mid-1950s, and its value falls off
 * sharply after that. For anyone recent it is the wrong tool, so the panel
 * leads with a general search instead.
 */
export function isHistorical(p: Searchable) {
  const d = Number(year(p.died));
  const b = Number(year(p.born));
  if (d) return d < 1960;
  if (b) return b < 1930;
  // No dates at all: the tree is mostly nineteenth century, so assume so.
  return true;
}

/** A Trove newspaper search — births, deaths, marriages and obituaries. */
export function troveSearch(name: string, place?: string) {
  const q = place ? `"${name}" ${place}` : `"${name}"`;
  return `https://trove.nla.gov.au/search/newspapers/results?keyword=${encodeURIComponent(
    q,
  )}`;
}

/** A plain web search, with whatever narrows it down. */
export function webSearch(p: Searchable) {
  const bits = [`"${p.name}"`];
  if (p.nee) bits.push(`OR "${p.name.split(" ")[0]} ${p.nee}"`);
  const place = p.bornPlace ?? p.diedPlace;
  if (place) bits.push(`"${place}"`);
  const b = year(p.born);
  const d = year(p.died);
  if (b && d) bits.push(`${b}..${d}`);
  else if (b) bits.push(b);
  return `https://www.google.com/search?q=${encodeURIComponent(bits.join(" "))}`;
}

/**
 * Open a new Claude conversation with the research question already written.
 * If the prefill is ever ignored it simply opens a new chat, which is a
 * harmless place to land.
 */
export function claudeResearch(p: Searchable) {
  const facts = [
    p.nee ? `${p.name}, née ${p.nee}` : p.name,
    p.born ? `born ${p.born}${p.bornPlace ? ` at ${p.bornPlace}` : ""}` : "",
    p.died ? `died ${p.died}${p.diedPlace ? ` at ${p.diedPlace}` : ""}` : "",
  ]
    .filter(Boolean)
    .join("; ");

  const prompt = `I am researching my family tree and would like help finding real records for one person.

${facts}

They belong to a New South Wales family descending from Sergeant Richard Guise of the NSW Corps, who arrived in 1792 — the line runs Guise, Brownlow, Bradney, Jones, Rock, and then Freestone, Staber and Bastock by marriage.

Please search for them and tell me:
1. Which birth, death, marriage, burial, immigration or land records are likely to exist, and where they are held.
2. Anything you can actually find online, with links.
3. Where the evidence is thin or where I might be conflating two people with similar names.

Be honest about what is confirmed versus what is a guess, and cite your sources.`;

  return `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;
}
