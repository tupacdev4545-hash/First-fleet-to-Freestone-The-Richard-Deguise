import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { DynamoDBClient, PutItemCommand, ScanCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});
const ses = new SESv2Client({});

const TABLE = process.env.TABLE_NAME;
const SITE_BUCKET = process.env.SITE_BUCKET;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const PASSCODE = process.env.FAMILY_PASSCODE ?? "";
const SITE_URL = (process.env.SITE_URL ?? "").replace(/\/$/, "");
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ?? "*";
const REGION = process.env.AWS_REGION ?? "ap-southeast-2";

/** Photographs live here, inside the site bucket, so the CDN serves them. */
const LIVE_PREFIX = "photos/live";
/** Photographs per person, counting the ones already in the record. */
const MAX_PHOTOS = 5;

/**
 * The deployed record, shipped inside the Lambda zip by deploy.sh. Used to
 * count each person's existing photographs and to check where a new relative
 * can hang before the archivist approves them.
 */
let RECORD = { people: [], unions: [] };
try {
  RECORD = JSON.parse(readFileSync(new URL("./tree.json", import.meta.url), "utf8"));
} catch {
  // Older zips had no tree.json. Everything below degrades to "no record".
}
const recordPerson = (id) => RECORD.people.find((p) => p.id === id);
const recordPhotos = (id) => recordPerson(id)?.photos ?? [];

/** The API as the archivist's emails reach it — through the site's domain. */
const API_BASE = SITE_URL ? `${SITE_URL}/api` : "";
const GALLERY_KEY = "gallery.json";

// No CORS headers here on purpose. The Function URL's own Cors block answers
// preflight and stamps the headers onto every response; setting them here as
// well would send each one twice, which browsers reject outright.
// ALLOW_ORIGIN stays in the environment because the template derives the URL's
// allowed origin from the same value, and it is useful in the logs.
void ALLOW_ORIGIN;

const reply = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const page = (statusCode, title, message) => ({
  statusCode,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: `<!doctype html><meta charset="utf-8">
<title>${escape(title)}</title>
<style>
 body{font-family:ui-serif,Georgia,serif;background:#fbf9f5;color:#201a14;
      display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
 div{max-width:34rem;text-align:center}
 h1{font-size:1.6rem;margin:0 0 .5rem}
 p{color:#574d42;line-height:1.6;font-size:.95rem}
 a{color:#8c2f16}
</style>
<div><h1>${escape(title)}</h1><p>${message}</p>
${SITE_URL ? `<p><a href="${escape(SITE_URL)}">Back to the family tree</a></p>` : ""}</div>`,
});

/* ----------------------------------------------------------- presigning --- */

const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const hmacRaw = (key, v) => createHmac("sha256", key).update(v).digest();

const encodePath = (key) =>
  key
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");

/**
 * A SigV4 query-string presigned S3 URL, built by hand so the function runs on
 * the bare Node runtime with no bundling step.
 */
function presign(method, bucket, key, expires) {
  const host = `${bucket}.s3.${REGION}.amazonaws.com`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/s3/aws4_request`;

  const params = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${process.env.AWS_ACCESS_KEY_ID}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };
  if (process.env.AWS_SESSION_TOKEN) {
    params["X-Amz-Security-Token"] = process.env.AWS_SESSION_TOKEN;
  }

  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");

  const canonicalRequest = [
    method,
    `/${encodePath(key)}`,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");

  const signature = createHmac(
    "sha256",
    hmacRaw(
      hmacRaw(
        hmacRaw(hmacRaw(`AWS4${process.env.AWS_SECRET_ACCESS_KEY}`, dateStamp), REGION),
        "s3",
      ),
      "aws4_request",
    ),
  )
    .update(stringToSign)
    .digest("hex");

  return `https://${host}/${encodePath(key)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/* ------------------------------------------------------------ utilities --- */

function escape(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

const str = (v, max) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const ALLOWED_IMAGE = new Set([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
  "image/gif",
  "image/tiff",
]);

const EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/tiff": "tif",
};

/** Constant-time compare so the passcode cannot be guessed a character at a time. */
function passcodeOk(given) {
  if (!PASSCODE) return false;
  const a = Buffer.from(sha256(String(given ?? "")), "hex");
  const b = Buffer.from(sha256(PASSCODE), "hex");
  return timingSafeEqual(a, b);
}

/** Signs the archivist's one-click removal links. */
const removalToken = (id) =>
  createHmac("sha256", `${ADMIN_EMAIL}:${PASSCODE}`).update(id).digest("hex").slice(0, 32);

/** Signs the archivist's "Add to the tree" links. Separate from removal. */
const approveToken = (id) => removalToken(`approve:${id}`);

const tokenOk = (given, want) =>
  typeof given === "string" &&
  given.length === want.length &&
  timingSafeEqual(Buffer.from(given), Buffer.from(want));

const approveUrl = (id) => `${API_BASE}/approve?id=${encodeURIComponent(id)}&t=${approveToken(id)}`;
const removeUrlFor = (id, base = API_BASE) => `${base}/remove?id=${encodeURIComponent(id)}&t=${removalToken(id)}`;

function readBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");
  if (raw.length > 40000) throw new Error("too-large");
  return JSON.parse(raw);
}

const OUTCOME_WORDS = {
  "still-together": "still together — an additional partner",
  separated: "separated",
  divorced: "divorced",
  widowed: "widowed",
  "chart-wrong": "the tree has that partnership wrong",
};

const RELATIONSHIP_WORDS = {
  child: "a child of",
  parent: "a parent of",
  partner: "a spouse or partner of",
  sibling: "a sibling of",
};

/* ------------------------------------------------------------ the table -- */

/** Every row matching a filter. The table is small; a scan is fine. */
async function scanAll(params = {}) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey, ...params }));
    items.push(...(res.Items ?? []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function getRow(id) {
  const rows = await scanAll({
    FilterExpression: "#id = :id",
    ExpressionAttributeNames: { "#id": "id" },
    ExpressionAttributeValues: { ":id": { S: id } },
  });
  return rows[0];
}

const isConditionFail = (e) => e?.name === "ConditionalCheckFailedException";

/* ---------------------------------------------------------- photo slots -- */
// Each person has MAX_PHOTOS spots, less whatever the record already holds.
// A counter row per person ("slots#<id>") is claimed with a conditional write,
// so two people uploading at the same moment cannot go past the limit. Only
// the archivist's take-down link gives a spot back.

const slotKey = (pid) => ({ id: { S: `slots#${pid}` } });
const allowedFor = (pid) => Math.max(0, MAX_PHOTOS - recordPhotos(pid).length);

/** The first time a person is seen, start their counter at what is live. */
async function seedSlots(pid) {
  const live = await scanAll({
    FilterExpression: "#k = :photo AND #s = :live AND personId = :pid",
    ExpressionAttributeNames: { "#k": "kind", "#s": "status" },
    ExpressionAttributeValues: {
      ":photo": { S: "photo" }, ":live": { S: "live" }, ":pid": { S: pid },
    },
  });
  await ddb
    .send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: slotKey(pid),
        UpdateExpression: "SET used = :n, #k = :slots, personId = :pid",
        ConditionExpression: "attribute_not_exists(id)",
        ExpressionAttributeNames: { "#k": "kind" },
        ExpressionAttributeValues: {
          ":n": { N: String(live.length) }, ":slots": { S: "slots" }, ":pid": { S: pid },
        },
      }),
    )
    .catch((e) => {
      if (!isConditionFail(e)) throw e;
    });
}

/** True if a spot is free. Checks only; does not take it. */
async function slotFree(pid) {
  await seedSlots(pid);
  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: slotKey(pid),
        UpdateExpression: "SET checkedAt = :now",
        ConditionExpression: "used < :allowed",
        ExpressionAttributeValues: {
          ":now": { S: new Date().toISOString() },
          ":allowed": { N: String(allowedFor(pid)) },
        },
      }),
    );
    return true;
  } catch (e) {
    if (isConditionFail(e)) return false;
    throw e;
  }
}

/** Take a spot for good. False if they are all used. */
async function claimSlot(pid) {
  await seedSlots(pid);
  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: slotKey(pid),
        UpdateExpression: "ADD used :one",
        ConditionExpression: "used < :allowed",
        ExpressionAttributeValues: {
          ":one": { N: "1" },
          ":allowed": { N: String(allowedFor(pid)) },
        },
      }),
    );
    return true;
  } catch (e) {
    if (isConditionFail(e)) return false;
    throw e;
  }
}

async function releaseSlot(pid) {
  await ddb
    .send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: slotKey(pid),
        UpdateExpression: "ADD used :minus",
        ConditionExpression: "used > :zero",
        ExpressionAttributeValues: { ":minus": { N: "-1" }, ":zero": { N: "0" } },
      }),
    )
    .catch((e) => {
      if (!isConditionFail(e)) throw e;
    });
}

/* ------------------------------------------------------ adding a person -- */

/**
 * Why a proposed relative cannot be placed yet, or null if they can. Checks
 * the record plus anyone the family has already added.
 */
function placementProblem(row, liveRelatives) {
  const pid = row.personId?.S;
  const rel = row.relationship?.S ?? "child";
  const name = row.personName?.S ?? "This person";
  const parentUnion = RECORD.unions.find((u) => u.children.includes(pid));
  const liveParents = liveRelatives.filter(
    (r) => r.personId?.S === pid && r.relationship?.S === "parent",
  ).length;
  const parentChildOfLive = liveRelatives.some(
    (r) => r.relationship?.S === "child" && `live-${r.id.S}` === pid,
  );
  if (rel === "sibling" && !parentUnion && !liveParents && !parentChildOfLive) {
    return `${name} has no parents on the tree yet, so a sibling has nowhere to hang. Add a parent of ${name} first, then the sibling.`;
  }
  if (rel === "parent" && (parentUnion?.partners.length ?? 0) + liveParents >= 2) {
    return `${name} already has two parents on the tree.`;
  }
  return null;
}

/** The archivist's confirm page: the details, and one button. */
function approvePage(statusCode, title, inner) {
  return {
    statusCode,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
    },
    body: `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
 body{font-family:ui-serif,Georgia,serif;background:#fbf9f5;color:#201a14;margin:0;padding:24px;
      display:grid;place-items:center;min-height:100vh;box-sizing:border-box}
 main{max-width:32rem;width:100%}
 h1{font-size:1.6rem;font-weight:normal;line-height:1.25;margin:0 0 1.25rem}
 dl{display:grid;grid-template-columns:auto 1fr;gap:.45rem 1.25rem;margin:0 0 1.5rem;
    padding:1rem 0;border-block:1px solid #ddd3c2}
 dt{color:#8a7c6c} dd{margin:0}
 .warn{border:1px solid #cdbfa9;background:#f7f1e6;border-radius:10px;padding:12px 14px;margin:0 0 1.25rem;
       font-size:.95rem;line-height:1.5}
 .stop{border-color:#e0b8a8;background:#fbf1ec}
 button{font:inherit;font-size:1.05rem;width:100%;padding:.85rem;border:0;border-radius:8px;
        background:#2f5d3a;color:#fff;cursor:pointer}
 button[disabled]{opacity:.6;cursor:default}
 button:focus-visible,a:focus-visible{outline:3px solid #9cc3a6;outline-offset:2px}
 p{color:#574d42;line-height:1.6;font-size:.95rem}
 a{color:#8c2f16}
</style>
<main><h1>${escape(title)}</h1>${inner}
${SITE_URL ? `<p><a href="${escape(SITE_URL)}">Open the family tree</a></p>` : ""}</main></html>`,
  };
}

function relativeDetails(row) {
  const v = (k) => row[k]?.S;
  const rows = [
    ["Adding", `<strong>${escape(v("newPersonName"))}</strong> as ${escape(RELATIONSHIP_WORDS[v("relationship")] ?? v("relationship") ?? "")} ${escape(v("personName") ?? "")}`],
    v("newPerson_born") && ["Born", escape(v("newPerson_born"))],
    v("newPerson_bornPlace") && ["Born at", escape(v("newPerson_bornPlace"))],
    v("newPerson_died") && ["Died", escape(v("newPerson_died"))],
    v("newPerson_blurb") && ["About them", escape(v("newPerson_blurb"))],
    v("notes") && ["Notes", escape(v("notes"))],
    ["Sent by", `${escape(v("submitterName") ?? "")} &lt;${escape(v("submitterEmail") ?? "")}&gt;`],
  ].filter(Boolean);
  return `<dl>${rows.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join("")}</dl>`;
}

/** Re-send approve buttons for everything still waiting. */
async function resendPending() {
  const pending = await scanAll({
    FilterExpression: "#k = :rel AND #s = :pending",
    ExpressionAttributeNames: { "#k": "kind", "#s": "status" },
    ExpressionAttributeValues: { ":rel": { S: "relative" }, ":pending": { S: "pending" } },
  });
  if (!pending.length) return { sent: 0 };
  const blocks = pending
    .sort((a, b) => (a.createdAt?.S ?? "").localeCompare(b.createdAt?.S ?? ""))
    .map(
      (r) => `<div style="border-top:1px solid #ddd3c2;padding:14px 0">
        <p style="margin:0 0 8px"><strong>${escape(r.newPersonName?.S ?? "")}</strong> as ${escape(
          RELATIONSHIP_WORDS[r.relationship?.S] ?? r.relationship?.S ?? "",
        )} ${escape(r.personName?.S ?? "")} <span style="color:#8a7c6c">· from ${escape(r.submitterName?.S ?? "")}</span></p>
        ${approveButton(r.id.S)}
      </div>`,
    )
    .join("");
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: ADMIN_EMAIL,
      Destination: { ToAddresses: [ADMIN_EMAIL] },
      Content: {
        Simple: {
          Subject: { Data: `Family tree — ${pending.length} ${pending.length === 1 ? "person" : "people"} waiting to be added`, Charset: "UTF-8" },
          Body: {
            Html: {
              Data: `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#241d16;max-width:640px">
<h2 style="margin:0 0 8px">Waiting to be added</h2>${blocks}</div>`,
              Charset: "UTF-8",
            },
          },
        },
      },
    }),
  );
  return { sent: pending.length };
}

function approveButton(id) {
  return `<a href="${escape(approveUrl(id))}" target="_blank" rel="noopener"
    style="display:inline-block;padding:11px 18px;background:#2f5d3a;color:#fff;border-radius:8px;text-decoration:none">Add to the tree</a>`;
}

/* ------------------------------------------------------------- gallery ---- */

/**
 * Rewrite gallery.json from the table, so the live site picks up every
 * published photograph and life story without a redeploy. Regenerating from
 * the table rather than appending means two people contributing at once cannot
 * lose each other's work.
 */
async function rebuildGallery() {
  const items = await scanAll({
    FilterExpression: "#s = :live",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":live": { S: "live" } },
  });

  const byDate = (a, b) => (a.at ?? "").localeCompare(b.at ?? "");

  const photos = items
    .filter((i) => i.kind?.S === "photo" && i.publicPath?.S && i.personId?.S)
    .map((i) => ({
      id: i.id.S,
      personId: i.personId.S,
      src: i.publicPath.S,
      caption: i.caption?.S,
      by: i.submitterName?.S,
      at: i.createdAt?.S,
    }))
    .sort(byDate);

  // A person has one story. The most recent one published wins — each writer
  // starts from what is already there, so the newest is the fullest.
  const latest = new Map();
  for (const i of items) {
    if (i.kind?.S !== "biography" || !i.text?.S || !i.personId?.S) continue;
    const row = {
      id: i.id.S,
      personId: i.personId.S,
      text: i.text.S,
      by: i.submitterName?.S,
      at: i.createdAt?.S,
    };
    const held = latest.get(row.personId);
    if (!held || byDate(held, row) < 0) latest.set(row.personId, row);
  }
  const stories = [...latest.values()].sort(byDate);

  // People the archivist has approved. The browser hangs them on the tree.
  const relatives = items
    .filter((i) => i.kind?.S === "relative" && i.newPersonName?.S && i.personId?.S)
    .map((i) => ({
      id: `live-${i.id.S}`,
      personId: i.personId.S,
      relationship: i.relationship?.S ?? "child",
      otherParentId: i.otherParentId?.S,
      name: i.newPersonName.S,
      born: i.newPerson_born?.S,
      died: i.newPerson_died?.S,
      bornPlace: i.newPerson_bornPlace?.S,
      blurb: i.newPerson_blurb?.S,
      by: i.submitterName?.S,
      at: i.approvedAt?.S ?? i.createdAt?.S,
    }))
    .sort(byDate);

  // Each person's chosen main photograph: a live photo id or a record src.
  const primary = {};
  for (const i of items) {
    if (i.kind?.S === "primary" && i.personId?.S && i.photoId?.S) {
      primary[i.personId.S] = i.photoId.S;
    }
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: SITE_BUCKET,
      Key: GALLERY_KEY,
      Body: JSON.stringify({
        updated: new Date().toISOString(),
        photos,
        stories,
        relatives,
        primary,
      }),
      ContentType: "application/json",
      CacheControl: "no-cache, must-revalidate",
    }),
  );

  return { photos: photos.length, stories: stories.length, relatives: relatives.length };
}

/* ----------------------------------------------------------- the handler -- */

export const handler = async (event) => {
  // Only reachable with `aws lambda invoke` (scripts/resend-pending.sh). A
  // Function URL request never carries a top-level "source".
  if (event?.source === "deguise.resend-pending") {
    return resendPending();
  }

  const method =
    event?.requestContext?.http?.method ?? event?.httpMethod ?? "POST";
  const path = event?.rawPath ?? event?.requestContext?.http?.path ?? "/";
  const sourceIp = event?.requestContext?.http?.sourceIp ?? "unknown";
  const qs = event?.queryStringParameters ?? {};

  // Browser preflight never reaches here — the Function URL answers it. This
  // is only for a bare OPTIONS with no preflight headers.
  if (method === "OPTIONS") return { statusCode: 204 };

  /* --- the archivist's one-click removal link --- */
  if (method === "GET" && path.endsWith("/remove")) {
    const id = str(qs.id, 80);
    const token = str(qs.t, 64);
    if (!id || !token || token !== removalToken(id)) {
      return page(403, "That link is not valid", "It may have been changed in transit, or the family passcode has been rotated since it was sent.");
    }
    let key = "";
    let kind = "photo";
    try {
      const res = await ddb.send(
        new UpdateItemCommand({
          TableName: TABLE,
          Key: { id: { S: id } },
          UpdateExpression: "SET #s = :removed",
          ConditionExpression: "attribute_exists(id)",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":removed": { S: "removed" } },
          ReturnValues: "ALL_OLD",
        }),
      );
      key = res.Attributes?.storageKey?.S ?? "";
      kind = res.Attributes?.kind?.S ?? "photo";
      // A photograph coming down gives its spot back — once, however many
      // times the link is clicked.
      if (kind === "photo" && res.Attributes?.status?.S === "live" && res.Attributes?.personId?.S) {
        await releaseSlot(res.Attributes.personId.S);
      }
    } catch {
      return page(404, "Not found", "That contribution is not in the archive.");
    }
    if (key) {
      await s3
        .send(new DeleteObjectCommand({ Bucket: SITE_BUCKET, Key: key }))
        .catch(() => {});
    }
    await rebuildGallery();
    return page(
      200,
      "Taken down",
      kind === "relative"
        ? "They are off the tree. The proposal is kept in the archive, so it can be approved again later."
        : kind === "biography"
        ? "The story is off the tree. If someone had written an earlier one for that person it comes back; otherwise the record reads as it did before. It may linger in the CDN cache for a few minutes."
        : "The photograph is gone from the tree and deleted from storage. It may linger in the CDN cache for a few minutes.",
    );
  }

  /* --- the archivist's confirm page for adding a person --- */
  if (method === "GET" && path.endsWith("/approve")) {
    const id = str(qs.id, 80);
    if (!id || !tokenOk(qs.t, approveToken(id))) {
      return approvePage(403, "This link doesn't work", "<p>It is incomplete, or the family passcode has been changed since it was sent. Run <code>./scripts/resend-pending.sh</code> for fresh links.</p>");
    }
    const row = await getRow(id);
    if (!row || row.kind?.S !== "relative") {
      return approvePage(404, "Not found", "<p>There is no proposed person with this id.</p>");
    }
    const name = row.newPersonName?.S ?? "This person";
    if (row.status?.S === "live") {
      return approvePage(200, `${name} is already on the tree`, `${relativeDetails(row)}<p>Nothing more to do.</p>`);
    }
    if (row.status?.S === "removed") {
      return approvePage(200, `${name} was taken down`, `${relativeDetails(row)}<p>This was approved and later removed. Ask the family member to send it again if they should go back.</p>`);
    }
    const liveRelatives = await scanAll({
      FilterExpression: "#k = :rel AND #s = :live",
      ExpressionAttributeNames: { "#k": "kind", "#s": "status" },
      ExpressionAttributeValues: { ":rel": { S: "relative" }, ":live": { S: "live" } },
    });
    const problem = placementProblem(row, liveRelatives);
    const also = row.alsoRecordedWith?.SS ?? [];
    const checks = [
      also.length &&
        `<div class="warn"><strong>Check this one privately.</strong> ${escape(row.personName?.S ?? "")} is already recorded with ${escape(also.join(" and "))}. Confirm which partnership is current before adding.</div>`,
      row.displacesName?.S &&
        `<div class="warn"><strong>This changes a partnership.</strong> ${escape(row.personName?.S ?? "")} is recorded with ${escape(row.displacesName.S)}. Contributor says: ${escape(OUTCOME_WORDS[row.displacesOutcome?.S] ?? row.displacesOutcome?.S ?? "unspecified")}.</div>`,
    ].filter(Boolean).join("");
    if (problem) {
      return approvePage(200, `${name} can't be added yet`, `${relativeDetails(row)}<div class="warn stop">${escape(problem)}</div>`);
    }
    return approvePage(200, `Add ${name} to the tree?`, `${relativeDetails(row)}${checks}
<button id="go" type="button">Add to the tree</button>
<p id="msg">They appear on the site for everyone straight away. The email's take-down link still removes them.</p>
<script>
const go = document.getElementById("go"), msg = document.getElementById("msg");
go.addEventListener("click", async () => {
  go.disabled = true; go.textContent = "Adding…";
  const body = JSON.stringify({ id: ${JSON.stringify(id)}, t: ${JSON.stringify(String(qs.t))} });
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  try {
    const res = await fetch(location.pathname, {
      method: "POST",
      headers: { "content-type": "application/json", "x-amz-content-sha256": hash },
      body,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || "Something went wrong (" + res.status + ")");
    document.querySelector("h1").textContent = out.name + " has been added";
    go.remove();
    msg.innerHTML = "They are on the tree now. Reload the site to see them. " +
      '<a href="' + out.removeUrl + '">Take it down</a> if that was a mistake.';
  } catch (e) {
    go.disabled = false; go.textContent = "Add to the tree";
    msg.textContent = e.message;
  }
});
</script>`);
  }

  if (method !== "POST") return reply(405, { error: "Method not allowed" });

  let input;
  try {
    input = readBody(event);
  } catch (e) {
    return e.message === "too-large"
      ? reply(413, { error: "Too large" })
      : reply(400, { error: "Body must be JSON" });
  }

  /* --- a presigned PUT straight into the public photo folder --- */
  if (path.endsWith("/upload-url")) {
    if (!passcodeOk(input.passcode)) {
      return reply(401, { error: "That family passcode is not right." });
    }
    const fileType = str(input.fileType, 100) ?? "";
    if (!ALLOWED_IMAGE.has(fileType)) {
      return reply(415, { error: "That image format is not accepted" });
    }
    const forPerson = str(input.personId, 120);
    if (forPerson && !(await slotFree(forPerson))) {
      return reply(409, { error: `All ${MAX_PHOTOS} photo spots for this person are used.` });
    }
    const key = `${LIVE_PREFIX}/${randomUUID()}.${EXT[fileType] ?? "bin"}`;
    return reply(200, {
      key,
      publicPath: `/${key}`,
      url: presign("PUT", SITE_BUCKET, key, 900),
    });
  }

  /* --- photographs are permanent once added --- */
  // Only the archivist's take-down link can remove one. This endpoint stays
  // so an old cached page gets a clear answer rather than a 404.
  if (path.endsWith("/delete-photo")) {
    return reply(410, { error: "Photographs stay once they are added. Ask the archivist if one needs to come down." });
  }

  /* --- approving a person from the confirm page --- */
  if (path.endsWith("/approve")) {
    const id = str(input.id, 80);
    if (!id || !tokenOk(input.t, approveToken(id))) {
      return reply(403, { error: "That link is not valid any more." });
    }
    const row = await getRow(id);
    if (!row || row.kind?.S !== "relative") return reply(404, { error: "Not found" });
    const name = row.newPersonName?.S ?? "They";
    if (row.status?.S === "live") {
      return reply(200, { ok: true, name, removeUrl: removeUrlFor(id) });
    }
    const liveRelatives = await scanAll({
      FilterExpression: "#k = :rel AND #s = :live",
      ExpressionAttributeNames: { "#k": "kind", "#s": "status" },
      ExpressionAttributeValues: { ":rel": { S: "relative" }, ":live": { S: "live" } },
    });
    const problem = placementProblem(row, liveRelatives);
    if (problem) return reply(409, { error: problem });
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: TABLE,
          Key: { id: { S: id } },
          UpdateExpression: "SET #s = :live, approvedAt = :now",
          ConditionExpression: "#k = :rel AND #s = :pending",
          ExpressionAttributeNames: { "#s": "status", "#k": "kind" },
          ExpressionAttributeValues: {
            ":live": { S: "live" },
            ":pending": { S: "pending" },
            ":rel": { S: "relative" },
            ":now": { S: new Date().toISOString() },
          },
        }),
      );
    } catch (e) {
      if (!isConditionFail(e)) throw e;
      return reply(409, { error: "This one was taken down. Ask for it to be sent again." });
    }
    await rebuildGallery();
    return reply(200, { ok: true, name, removeUrl: removeUrlFor(id) });
  }

  /* --- choosing a person's main photograph --- */
  if (path.endsWith("/primary")) {
    if (!passcodeOk(input.passcode)) {
      return reply(401, { error: "That family passcode is not right." });
    }
    const personId = str(input.personId, 120);
    const photoId = str(input.photoId, 400);
    if (!personId || !photoId) return reply(400, { error: "Which photograph?" });

    let ok = recordPhotos(personId).some((p) => p.src === photoId);
    if (!ok) {
      const row = await getRow(photoId);
      ok = row?.kind?.S === "photo" && row.status?.S === "live" && row.personId?.S === personId;
    }
    if (!ok) return reply(400, { error: "That photograph does not belong to this person." });

    await ddb.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: {
          id: { S: `primary#${personId}` },
          kind: { S: "primary" },
          status: { S: "live" },
          personId: { S: personId },
          photoId: { S: photoId },
          createdAt: { S: new Date().toISOString() },
          sourceIp: { S: sourceIp },
        },
      }),
    );
    await rebuildGallery();
    return reply(200, { ok: true, personId, photoId });
  }

  if (!path.endsWith("/proposals") && !path.endsWith("/submissions")) {
    return reply(404, { error: "Not found" });
  }

  const kind = str(input.kind, 20) ?? "relative";
  if (!["photo", "biography", "relative"].includes(kind)) {
    return reply(400, { error: "Unknown kind" });
  }

  const contributor = input.contributor ?? {};
  const who = {
    name: str(contributor.name, 120),
    email: str(contributor.email, 200),
  };
  if (!who.name) return reply(400, { error: "Your name is required" });
  if (!who.email || !EMAIL.test(who.email)) {
    return reply(400, { error: "A valid email is required" });
  }
  if (str(input.website, 200)) return reply(202, { ok: true });

  const personId = str(input.personId, 120);
  const personName = str(input.personName, 160);
  if (!personId || !personName) {
    return reply(400, { error: "Which person is this about?" });
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  // Photographs and life stories publish immediately for anyone holding the
  // family passcode. Anything that changes the *shape* of the tree — a new
  // person, a new marriage — still waits for the archivist.
  //
  // A photograph cannot get this far without the passcode: signing the upload
  // needed it. A story can, and a stranger who has a real memory to add should
  // not be turned away, so a blank passcode quietly queues it instead. A wrong
  // one is an error, not a silent demotion — otherwise a typo would look like
  // the site had swallowed their work.
  const given = str(input.passcode, 200);
  const canPublish = kind === "photo" || kind === "biography";
  if (given && !passcodeOk(given)) {
    return reply(401, { error: "That family passcode is not right." });
  }
  if (kind === "photo" && !given) {
    return reply(401, { error: "The family passcode is needed for photographs." });
  }
  const live = canPublish && Boolean(given);

  const item = {
    id: { S: id },
    createdAt: { S: now },
    status: { S: live ? "live" : "pending" },
    kind: { S: kind },
    personId: { S: personId },
    personName: { S: personName },
    submitterName: { S: who.name },
    submitterEmail: { S: who.email },
    sourceIp: { S: sourceIp },
  };

  let rows = "";
  let extra = "";
  /** Shown above the table for anything already on the site. */
  let preview = "";

  {
    if (kind === "photo") {
      const storageKey = str(input.storageKey, 300);
      const publicPath = str(input.publicPath, 300);
      if (!storageKey || !publicPath || !storageKey.startsWith(`${LIVE_PREFIX}/`)) {
        return reply(400, { error: "The upload did not complete" });
      }
      if (!(await claimSlot(personId))) {
        await s3
          .send(new DeleteObjectCommand({ Bucket: SITE_BUCKET, Key: storageKey }))
          .catch(() => {});
        return reply(409, { error: `All ${MAX_PHOTOS} photo spots for this person are used.` });
      }
      item.storageKey = { S: storageKey };
      item.publicPath = { S: publicPath };
      const caption = str(input.caption, 400);
      if (caption) item.caption = { S: caption };
      if (str(input.fileName, 300)) item.fileName = { S: input.fileName.trim() };

      rows = `<tr><td>Caption</td><td>${escape(caption ?? "—")}</td></tr>
              <tr><td>File</td><td>${escape(input.fileName ?? storageKey)}</td></tr>`;
      preview = `<p style="margin:0 0 16px"><img src="${escape(SITE_URL + publicPath)}" alt="" style="max-width:100%;max-height:320px;border-radius:10px;border:1px solid #ddd3c2"></p>`;
    }

    if (kind === "biography") {
      const text = str(input.text, 8000);
      if (!text) return reply(400, { error: "The story is empty" });
      item.text = { S: text };
      if (str(input.previousText, 8000)) item.previousText = { S: input.previousText.trim() };
      rows = `<tr><td>${live ? "Now reads" : "Proposed"}</td><td>${escape(text).replace(/\n/g, "<br>")}</td></tr>`;
      if (input.previousText) {
        rows += `<tr><td>${live ? "Was" : "Currently"}</td><td style="color:#8a7c6c">${escape(input.previousText).replace(/\n/g, "<br>")}</td></tr>`;
      }
    }

    if (kind === "relative") {
      const np = input.newPerson ?? {};
      const name = str(np.name, 160);
      if (!name) return reply(400, { error: "The new person needs a name" });
      const rel = str(input.relationship, 20) ?? "child";
      item.relationship = { S: rel };
      item.newPersonName = { S: name };
      for (const f of ["born", "died", "bornPlace", "blurb"]) {
        const v = str(np[f], 2000);
        if (v) item[`newPerson_${f}`] = { S: v };
      }
      if (str(input.notes, 2000)) item.notes = { S: input.notes.trim() };
      const otherParentId = str(input.otherParentId, 120);
      if (otherParentId) item.otherParentId = { S: otherParentId };

      rows = `<tr><td>Adding</td><td><strong>${escape(name)}</strong> as ${escape(
        RELATIONSHIP_WORDS[rel] ?? rel,
      )} ${escape(personName)}</td></tr>`;
      for (const [label, f] of [
        ["Born", "born"],
        ["Died", "died"],
        ["Born at", "bornPlace"],
        ["About them", "blurb"],
      ]) {
        const v = str(np[f], 2000);
        if (v) rows += `<tr><td>${label}</td><td>${escape(v)}</td></tr>`;
      }
      const notes = str(input.notes, 2000);
      if (notes) rows += `<tr><td>Notes</td><td>${escape(notes)}</td></tr>`;

      if (Array.isArray(input.alsoRecordedWith) && input.alsoRecordedWith.length) {
        const names = input.alsoRecordedWith.map((n) => str(n, 160)).filter(Boolean).slice(0, 6);
        if (names.length) {
          item.alsoRecordedWith = { SS: names };
          extra = `<div style="border:1px solid #cdbfa9;background:#f7f1e6;border-radius:10px;padding:12px 14px;margin:16px 0">
            <strong>Check this one privately.</strong><br>
            ${escape(personName)} is already recorded with <strong>${escape(names.join(" and "))}</strong>.
            Someone in that partnership is still living, so the form did not ask what happened.
            Confirm with the family which partnership is current before you publish.
          </div>`;
        }
      }

      const d = input.displaces;
      if (d && str(d.existingPartnerName, 160)) {
        item.displacesName = { S: d.existingPartnerName.trim() };
        if (str(d.outcome, 40)) item.displacesOutcome = { S: d.outcome.trim() };
        if (str(d.currentPartner, 160)) item.currentPartner = { S: d.currentPartner.trim() };
        extra += `<div style="border:1px solid #e0b8a8;background:#fbf1ec;border-radius:10px;padding:12px 14px;margin:16px 0">
          <strong>This changes an existing partnership.</strong><br>
          ${escape(personName)} is recorded with <strong>${escape(d.existingPartnerName)}</strong>.<br>
          Contributor says: <strong>${escape(OUTCOME_WORDS[d.outcome] ?? d.outcome ?? "unspecified")}</strong>.${
            d.currentPartner ? `<br>Current partner: <strong>${escape(d.currentPartner)}</strong>.` : ""
          }
        </div>`;
      }
    }
  }

  await ddb.send(new PutItemCommand({ TableName: TABLE, Item: item }));

  if (live) {
    const counts = await rebuildGallery();
    const removeUrl = `${str(input.apiBase, 300) ?? ""}/remove?id=${id}&t=${removalToken(id)}`;
    rows += `<tr><td>On the site</td><td>${counts.photos} photograph${
      counts.photos === 1 ? "" : "s"
    } and ${counts.stories} stor${counts.stories === 1 ? "y" : "ies"} live</td></tr>`;
    extra =
      preview +
      `<p><strong>This is already live on the site.</strong> If it should not be:</p>
      <p><a href="${escape(removeUrl)}" style="display:inline-block;padding:11px 18px;background:#8c2f16;color:#fff;border-radius:8px;text-decoration:none">Take it down</a></p>` +
      extra;
  }

  const heading = {
    photo: `Photograph added to ${personName}`,
    biography: live
      ? `${personName}'s story was rewritten`
      : `A life story for ${personName}`,
    relative: `A relative to add near ${personName}`,
  }[kind];

  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#241d16;max-width:640px">
<h2 style="margin:0 0 4px">${escape(heading)}</h2>
<p style="margin:0 0 16px;color:#8a7c6c">From ${escape(who.name)} &lt;${escape(who.email)}&gt; · ${escape(now)} · ${escape(id)}</p>
${extra}
<table style="border-collapse:collapse;width:100%">
<style>td{padding:5px 12px 5px 0;vertical-align:top}</style>
${rows}
</table>
${
  live
    ? ""
    : kind === "relative"
      ? `<p style="margin:20px 0 8px">${approveButton(id)}</p>
         <p style="margin:0;color:#8a7c6c">Opens a page where you confirm. Nothing changes until you press the button there.</p>`
      : `<p style="margin-top:20px;color:#8a7c6c">Waiting on approval. Pending list: <code>./scripts/submissions.sh</code></p>`
}
<p><a href="${escape(SITE_URL)}">${escape(SITE_URL)}</a></p>
</div>`;

  await ses
    .send(
      new SendEmailCommand({
        FromEmailAddress: ADMIN_EMAIL,
        Destination: { ToAddresses: [ADMIN_EMAIL] },
        ReplyToAddresses: [who.email],
        Content: {
          Simple: {
            Subject: { Data: `Family tree — ${heading}`, Charset: "UTF-8" },
            Body: { Html: { Data: html, Charset: "UTF-8" } },
          },
        },
      }),
    )
    .catch(() => {
      // A photograph that is already live should not fail because email did.
    });

  return reply(201, { ok: true, id, live });
};
