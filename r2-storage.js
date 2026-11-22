// r2-storage.js — talks to Cloudflare R2 (private bucket) through its S3-compatible API.
// Only the backend uses this. Browsers get short-lived signed links, never the keys.
// Env: R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
import {
    S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const accountId = process.env.R2_ACCOUNT_ID;
const bucket = process.env.R2_BUCKET;
const configured = !!(accountId && bucket && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
let client = null;

function s3() {
    if (!configured) throw new Error("File storage is not configured yet.");
    if (!client) {
        client = new S3Client({
            region: "auto",
            endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
            }
        });
    }
    return client;
}

export const r2Configured = () => configured;

// Link the browser uses to upload one file directly to R2. It expires quickly and works for one key only.
export async function presignUpload(key, contentType, expiresSec = 300) {
    return getSignedUrl(s3(), new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: expiresSec });
}

// Link to view one file. Short-lived, so a copied link stops working quickly.
export async function presignRead(key, expiresSec = 300) {
    return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresSec });
}

// Size and type of an uploaded file, or null if it isn't there.
export async function headObject(key) {
    try {
        const r = await s3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: Number(r.ContentLength || 0), contentType: r.ContentType || "" };
    } catch (e) {
        if (e.$metadata?.httpStatusCode === 404 || e.name === "NotFound") return null;
        throw e;
    }
}

export async function deleteObject(key) {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
