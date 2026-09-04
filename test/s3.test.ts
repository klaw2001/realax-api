import { randomUUID } from 'crypto'

import { DeleteObjectCommand } from '@aws-sdk/client-s3'

import { env } from '../src/config/env'
import s3, { getSignedUrl, headObject, keys, putObject } from '../src/lib/s3'

// These tests talk to the real bucket in ca-central-1. Individual cases measure
// 2.5-5s, which sits right on Jest's 5-second default — so the suite passed
// alone and failed under the parallel load of a full run, which is the worst
// kind of failing test: one that is right about the code and wrong about the
// day. The latency is real and worth waiting for; an integration test that
// mocked S3 would confirm a bucket configuration it never checked.
jest.setTimeout(30_000)


// An integration test — it talks to the real bucket. It is here because the
// things worth checking (SSE-KMS actually applied, an unsigned GET actually
// refused) are properties of the bucket configuration, not of this code, and a
// mocked S3 would happily confirm all of them while the bucket was public.

// A throwaway transaction prefix per run, so concurrent runs cannot collide and
// nothing lands under a real transaction.
const TX_ID = `test${randomUUID().replace(/-/g, '')}`
const KEY = keys.filledForm(TX_ID, 'test100')
const BODY = `realax s3 integration test ${new Date().toISOString()}`

const unsignedUrl = `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${KEY}`

afterAll(async () => {
    // A delete on a versioned bucket writes a delete marker; the object version
    // itself stays, which is what Object Lock is there to guarantee. This keeps
    // the live listing clean without pretending the data can be erased.
    await s3.send(new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: KEY }))
})

describe('the storage service', () => {
    test('putObject writes an encrypted, versioned object', async () => {
        const result = await putObject({ key: KEY, body: BODY, contentType: 'text/plain' })

        expect(result.key).toEqual(KEY)
        // Present only because versioning is on — its absence means the bucket
        // is misconfigured, not that the write failed.
        expect(result.versionId).toBeDefined()
    })

    test('headObject reports the object as SSE-KMS encrypted', async () => {
        const metadata = await headObject(KEY)

        expect(metadata).not.toBeNull()
        expect(metadata!.contentType).toEqual('text/plain')
        expect(metadata!.contentLength).toEqual(Buffer.byteLength(BODY))
        expect(metadata!.serverSideEncryption).toEqual('aws:kms')
    })

    test('headObject returns null for a key that is not there', async () => {
        expect(await headObject(keys.filledForm(TX_ID, 'nosuchform'))).toBeNull()
    })

    test('a presigned URL fetches the object', async () => {
        const url = await getSignedUrl(KEY, 60)
        const response = await fetch(url)

        expect(response.status).toEqual(200)
        expect(await response.text()).toEqual(BODY)
    })

    test('a direct unsigned GET is refused with 403', async () => {
        const response = await fetch(unsignedUrl)

        expect(response.status).toEqual(403)
    })

    test('a signed URL expires', async () => {
        // Signed one second into the past, so the check does not depend on the
        // test sleeping through a real TTL.
        const url = await getSignedUrl(KEY, 1)
        await new Promise(resolve => setTimeout(resolve, 2000))

        expect((await fetch(url)).status).toEqual(403)
    })

    test('the TTL is capped so nothing can mint a long-lived link', async () => {
        await expect(getSignedUrl(KEY, 86400)).rejects.toThrow(/TTL must be/)
    })
})

describe('the key convention', () => {
    test('builds the four documented shapes', () => {
        expect(keys.identityDocument('tx1', 'party1', 'drivers_licence')).toEqual(
            'transactions/tx1/ids/party1/drivers_licence.jpg'
        )
        expect(keys.filledForm('tx1', '100')).toEqual('transactions/tx1/forms/100/filled.pdf')
        expect(keys.signedForm('tx1', '100')).toEqual('transactions/tx1/forms/100/signed.pdf')
        expect(keys.auditTrail('tx1', 'env1')).toEqual('transactions/tx1/audit/env1.pdf')
    })

    test('refuses a segment that would escape the prefix', () => {
        expect(() => keys.filledForm('../../other', '100')).toThrow(/Invalid S3 key segment/)
        expect(() => keys.identityDocument('tx1', 'party1/../..', 'passport')).toThrow(
            /Invalid S3 key segment/
        )
    })
})
