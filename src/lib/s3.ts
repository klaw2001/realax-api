import {
    GetObjectCommand,
    HeadBucketCommand,
    HeadObjectCommand,
    NotFound,
    PutObjectCommand,
    S3Client
} from '@aws-sdk/client-s3'
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner'

import { env } from '@/config/env'
import logger from '@/lib/logger'

/**
 * The service's only S3 client.
 *
 * Credentials come from the SDK's default chain, so the same code works with
 * `AWS_ACCESS_KEY_ID` in `.env` locally and an instance role in production.
 *
 * The bucket is expected to have versioning on, Object Lock configured, and
 * Block Public Access on. Nothing here ever writes a public ACL — every read
 * is a presigned URL this service issues after its own auth check.
 */
const s3 = new S3Client({ region: env.AWS_REGION })

/** Presigned URLs are minutes, not hours. A leaked link should already be dead. */
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300
const MAX_SIGNED_URL_TTL_SECONDS = 900

/**
 * Keys are assembled from ids that arrive over HTTP. A `..` or a stray `/` in
 * one of them would silently write to another transaction's prefix, so every
 * segment is checked rather than trusted.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function segment(value: string, name: string): string {
    if (!SAFE_SEGMENT.test(value)) {
        // The offending value is not echoed — these are party and transaction
        // ids, and this message can end up in a log.
        throw new Error(`Invalid S3 key segment for "${name}"`)
    }

    return value
}

/**
 * The key convention, in one place. Nothing else in the codebase should build
 * a key by string concatenation — the layout is what makes retention and
 * lifecycle rules expressible as prefixes.
 *
 *   transactions/{txId}/ids/{partyId}/{docType}.jpg
 *   transactions/{txId}/forms/{formCode}/filled.pdf
 *   transactions/{txId}/forms/{formCode}/signed.pdf
 *   transactions/{txId}/audit/{envelopeId}.pdf
 */
export const keys = {
    /** An identity document scan. FINTRAC material — five year retention. */
    identityDocument(txId: string, partyId: string, docType: string, extension = 'jpg'): string {
        return (
            `transactions/${segment(txId, 'txId')}` +
            `/ids/${segment(partyId, 'partyId')}` +
            `/${segment(docType, 'docType')}.${segment(extension, 'extension')}`
        )
    },

    /** The filled, unsigned OREA form. */
    filledForm(txId: string, formCode: string): string {
        return `transactions/${segment(txId, 'txId')}/forms/${segment(formCode, 'formCode')}/filled.pdf`
    },

    /** The executed copy returned by the e-sign vendor. */
    signedForm(txId: string, formCode: string): string {
        return `transactions/${segment(txId, 'txId')}/forms/${segment(formCode, 'formCode')}/signed.pdf`
    },

    /** The vendor's audit trail / certificate of completion for one envelope. */
    auditTrail(txId: string, envelopeId: string): string {
        return `transactions/${segment(txId, 'txId')}/audit/${segment(envelopeId, 'envelopeId')}.pdf`
    }
}

export interface PutObjectInput {
    key: string
    body: Buffer | Uint8Array | string
    contentType: string
}

export interface PutObjectResult {
    key: string
    /** Present because the bucket is versioned; stored alongside the row that owns the object. */
    versionId?: string
    etag?: string
}

/**
 * Write an object. Always SSE-KMS, never an ACL.
 *
 * The encryption arguments are not optional parameters on purpose: a caller
 * that forgets them is how an unencrypted identity document happens.
 */
export async function putObject({ key, body, contentType }: PutObjectInput): Promise<PutObjectResult> {
    const response = await s3.send(
        new PutObjectCommand({
            Bucket: env.AWS_S3_BUCKET,
            Key: key,
            Body: body,
            ContentType: contentType,
            ServerSideEncryption: 'aws:kms',
            SSEKMSKeyId: env.AWS_KMS_KEY_ID
        })
    )

    return { key, versionId: response.VersionId, etag: response.ETag }
}

/**
 * A time-limited GET URL for one object.
 *
 * This is the only way anything outside the service reads a file. Call it
 * *after* the caller has been authorised for the transaction the key belongs
 * to — the URL itself carries no notion of who asked for it.
 */
export async function getSignedUrl(key: string, ttlSeconds = DEFAULT_SIGNED_URL_TTL_SECONDS): Promise<string> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_SIGNED_URL_TTL_SECONDS) {
        throw new Error(`Signed URL TTL must be 1–${MAX_SIGNED_URL_TTL_SECONDS} seconds`)
    }

    return presign(s3, new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key }), {
        expiresIn: ttlSeconds
    })
}

export interface ObjectMetadata {
    contentType?: string
    contentLength?: number
    versionId?: string
    etag?: string
    lastModified?: Date
    /** `aws:kms` for anything this service wrote. */
    serverSideEncryption?: string
}

/**
 * Metadata for an object, or `null` if it is not there.
 *
 * A missing object is an ordinary answer — a form that has not been filled yet
 * — so it is a null rather than a thrown 404 the caller has to unwrap.
 *
 * This depends on the IAM policy granting `s3:ListBucket`. Without it S3
 * answers a HEAD on an absent key with 403 rather than 404, to avoid confirming
 * what does not exist, and this returns a thrown error instead of null.
 */
export async function headObject(key: string): Promise<ObjectMetadata | null> {
    try {
        const response = await s3.send(new HeadObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key }))

        return {
            contentType: response.ContentType,
            contentLength: response.ContentLength,
            versionId: response.VersionId,
            etag: response.ETag,
            lastModified: response.LastModified,
            serverSideEncryption: response.ServerSideEncryption
        }
    } catch (error) {
        // S3 answers a HEAD on a missing key with a bare 404 and no body, which
        // the SDK surfaces as NotFound. Anything else — a denied key, a bad
        // signature — must keep propagating.
        if (error instanceof NotFound) {
            return null
        }

        throw error
    }
}

/**
 * Can this service reach its bucket with the credentials it has?
 *
 * A HEAD on the bucket, not on an object — it answers the question the health
 * endpoint is actually asking (region reachable, credentials valid, bucket
 * exists) without depending on any particular key being present.
 *
 * Returns `false` rather than throwing: an unreachable bucket is a health
 * *result*, not a failure of the check.
 */
export async function ping(): Promise<boolean> {
    try {
        await s3.send(new HeadBucketCommand({ Bucket: env.AWS_S3_BUCKET }))

        return true
    } catch (error) {
        logger.warn('s3 ping failed', { message: (error as Error).message })

        return false
    }
}

export default s3
