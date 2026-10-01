// Photo rules for the Guise family tree Lambda.
//
//  - Five photos per person, counting the ones already in tree.json.
//  - Every upload uses up a slot. Once up, nobody with the family passcode can
//    remove or replace it. Only the archivist's "Take it down" link can, and
//    that gives the slot back.
//  - Anyone with the passcode can choose which photo is the main one.
//
// ASSUMPTIONS: same DynamoDB table as approve.mjs (key `id`); photo rows have
// kind "photo", personId, status, key (S3 key). tree.json is in the site
// bucket at "tree.json", with person.photos as an array of paths.

import crypto from "node:crypto";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, UpdateCommand, PutCommand, GetCommand,
} from "@aws-sdk/lib-dynamodb";

const s3 = new S3Client({});
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME;
const BUCKET = process.env.SITE_BUCKET;
export const MAX_PHOTOS = 5;

// ---------- tree.json, cached for the life of the Lambda container ----------

let treeCache = null;
async function recordPhotos(personId) {
  if (!treeCache) {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: "tree.json" }));
    treeCache = JSON.parse(await res.Body.transformToString());
  }
  const p = treeCache.people.find((x) => x.id === personId);
  if (!p) throw httpError(404, "That person isn't on the tree.");
  return p.photos ?? [];
}

// ---------- 1. Claim a slot, then sign the upload ----------
// Replaces the body of the existing presign step. The slot is claimed with a
// conditional counter, so two people uploading at the same moment can't go
// past five.

export async function presignPhoto({ personId, contentType }) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(contentType)) {
    throw httpError(400, "Photos need to be JPEG, PNG, WebP or HEIC.");
  }
  const allowed = MAX_PHOTOS - (await recordPhotos(personId)).length;

  try {
    await db.send(new UpdateCommand({
      TableName: TABLE,
      Key: { id: `slots#${personId}` },
      UpdateExpression: "ADD used :one",
      ConditionExpression: "attribute_not_exists(used) OR used < :allowed",
      ExpressionAttributeValues: { ":one": 1, ":allowed": allowed },
    }));
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      throw httpError(409, `All ${MAX_PHOTOS} photo spots for this person are used.`);
    }
    throw err;
  }

  const photoId = crypto.randomUUID();
  const ext = contentType.split("/")[1].replace("jpeg", "jpg");
  const key = `photos/live/${personId}/${photoId}.${ext}`;

  // The key is made here, never by the browser, and IfNoneMatch means the
  // signed URL can only create the file, not overwrite an existing one.
  const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: BUCKET, Key: key, ContentType: contentType, IfNoneMatch: "*",
  }), { expiresIn: 300 });

  await db.send(new PutCommand({
    TableName: TABLE,
    Item: {
      id: photoId, kind: "photo", personId, key,
      status: "live", createdAt: new Date().toISOString(),
    },
  }));

  // The browser must send the header "If-None-Match: *" with its PUT.
  return { photoId, key, uploadUrl, uploadHeaders: { "If-None-Match": "*" } };
}

// ---------- 2. Archivist take-down gives the slot back ----------
// Call from the existing "Take it down" handler, after the photo row is
// marked taken_down.

export async function releaseSlot(personId) {
  await db.send(new UpdateCommand({
    TableName: TABLE,
    Key: { id: `slots#${personId}` },
    UpdateExpression: "ADD used :minus",
    ConditionExpression: "used > :zero",
    ExpressionAttributeValues: { ":minus": -1, ":zero": 0 },
  })).catch((err) => {
    if (err.name !== "ConditionalCheckFailedException") throw err;
  });

  // If the removed photo was the main one, fall back to the default.
  // (Simplest: delete primary#personId if it pointed at this photo, done by
  // the caller since it knows the photoId.)
}

// ---------- 3. Choose the main photo ----------
// New action, passcode required. photoId is either a live photo id or a
// tree.json photo path.

export async function setPrimary({ personId, photoId }, { rebuildGallery }) {
  const record = await recordPhotos(personId);
  let ok = record.includes(photoId);
  if (!ok) {
    const { Item } = await db.send(new GetCommand({ TableName: TABLE, Key: { id: photoId } }));
    ok = Item?.kind === "photo" && Item.personId === personId && Item.status === "live";
  }
  if (!ok) throw httpError(400, "That photo doesn't belong to this person.");

  await db.send(new PutCommand({
    TableName: TABLE,
    Item: { id: `primary#${personId}`, kind: "primary", personId, photoId,
            setAt: new Date().toISOString() },
  }));
  await rebuildGallery();
  return { personId, photoId };
}

// ---------- gallery.json ----------
// Inside rebuildGallery(), after the scan:
//
//   gallery.primary = toPrimaryMap(items);
//
// gives { personId: photoId } for the browser.

export function toPrimaryMap(items) {
  const map = {};
  for (const it of items) if (it.kind === "primary") map[it.personId] = it.photoId;
  return map;
}

// ---------- removal is closed to passcode holders ----------
// If the main handler has any delete/replace photo action reachable with only
// the passcode, delete it. The take-down link (HMAC-signed, sent only to the
// archivist) is the one way a photo comes down.

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
