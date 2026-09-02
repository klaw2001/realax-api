import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

import { env } from '@/config/env'

/**
 * Field-level encryption, for the columns the data model says are encrypted at
 * rest.
 *
 * There is exactly one today: `IdentityRecord.documentNumber`. The schema has
 * carried the comment "encrypted at rest" since build plan 0.2 and nothing
 * implemented it, which is worse than not claiming it — a column labelled
 * encrypted that holds a driver's licence number in plain text is a column
 * nobody thinks to check.
 *
 * This is separate from, and additional to, the storage encryption. The bucket
 * is SSE-KMS and the database volume is encrypted by the provider, but both of
 * those protect against someone taking the disk. Neither protects against a
 * query. A licence number that appears in a `SELECT *`, a database export, a
 * backup handed to a contractor or a log line that printed a row is exposed,
 * and this is what stops that.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than decrypting to something else. A fresh 96-bit IV per value — never a
 * fixed one, which for GCM is not "less secure" but catastrophic, since two
 * values encrypted under one key and IV leak their XOR.
 *
 * Deterministic encryption is deliberately not offered. It would allow looking
 * a party up by licence number, and it does that by making equal numbers
 * produce equal ciphertext, which is the property that turns a leaked table
 * into a searchable index of who holds which document.
 */

const ALGORITHM = 'aes-256-gcm'

/** 96 bits, which is the size GCM is specified and optimised for. */
const IV_BYTES = 12

const KEY_BYTES = 32

/**
 * The stored format's version prefix.
 *
 * Present from the first value written so that rotating a key or changing the
 * cipher later is a migration that can tell old values from new ones, rather
 * than a guess about what a given blob is.
 */
const VERSION = 'v1'

export class EncryptionKeyError extends Error {
    constructor(detail: string) {
        super(`IDENTITY_ENCRYPTION_KEY is not usable: ${detail}`)
        this.name = 'EncryptionKeyError'
    }
}

export class DecryptionError extends Error {
    constructor(detail: string) {
        // No ciphertext, no key material, no partial plaintext. This message
        // reaches a log.
        super(`Could not decrypt a stored value: ${detail}`)
        this.name = 'DecryptionError'
    }
}

/**
 * The key, decoded once.
 *
 * Base64 or hex, 32 bytes either way. Read lazily rather than at module load so
 * that importing anything that transitively touches this file does not require
 * the key to be present — only actually encrypting or decrypting does.
 */
let cachedKey: Buffer | null = null

const key = (): Buffer => {
    if (cachedKey) {
        return cachedKey
    }

    const raw = env.IDENTITY_ENCRYPTION_KEY
    const decoded = /^[0-9a-fA-F]{64}$/.test(raw)
        ? Buffer.from(raw, 'hex')
        : Buffer.from(raw, 'base64')

    if (decoded.length !== KEY_BYTES) {
        // The length only, never the value.
        throw new EncryptionKeyError(
            `expected ${KEY_BYTES} bytes of key material, decoded ${decoded.length}`
        )
    }

    cachedKey = decoded

    return cachedKey
}

/**
 * Encrypt one field value.
 *
 * The result is `v1.<iv>.<tag>.<ciphertext>`, all base64url. One column, one
 * self-describing string — an IV in a second column is one migration away from
 * being separated from the value it belongs to.
 */
export const encryptField = (plaintext: string): string => {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, key(), iv)

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()

    return [
        VERSION,
        iv.toString('base64url'),
        tag.toString('base64url'),
        ciphertext.toString('base64url')
    ].join('.')
}

/**
 * Decrypt one field value.
 *
 * Throws rather than returning null on anything that is not a well-formed
 * value under this key. A licence number that silently comes back empty is a
 * FINTRAC record that silently stopped being one.
 */
export const decryptField = (stored: string): string => {
    const parts = stored.split('.')

    if (parts.length !== 4) {
        throw new DecryptionError('the stored value is not in the expected format')
    }

    const [version, ivPart, tagPart, ciphertextPart] = parts

    if (version !== VERSION) {
        throw new DecryptionError(`unknown format version '${version}'`)
    }

    const iv = Buffer.from(ivPart, 'base64url')
    const tag = Buffer.from(tagPart, 'base64url')

    if (iv.length !== IV_BYTES || tag.length !== 16) {
        throw new DecryptionError('the stored value has a malformed header')
    }

    try {
        const decipher = createDecipheriv(ALGORITHM, key(), iv)
        decipher.setAuthTag(tag)

        return Buffer.concat([
            decipher.update(Buffer.from(ciphertextPart, 'base64url')),
            decipher.final()
        ]).toString('utf8')
    } catch (error) {
        if (error instanceof EncryptionKeyError) {
            throw error
        }

        // The authentication tag did not verify: the value was written under a
        // different key, or it has been altered. Which of the two is not
        // something this can tell, and the remedy is the same either way.
        throw new DecryptionError('it does not verify under the current key')
    }
}

/** Whether a stored string is one of ours, without attempting to decrypt it. */
export const isEncrypted = (stored: string): boolean => stored.startsWith(`${VERSION}.`)

/**
 * Compare a candidate against an encrypted value without leaving the plaintext
 * anywhere the caller has to remember to discard.
 *
 * Constant-time on the comparison itself. The lengths still differ observably,
 * which for a licence number is not information worth the complexity of hiding.
 */
export const matchesEncrypted = (stored: string, candidate: string): boolean => {
    const plaintext = Buffer.from(decryptField(stored), 'utf8')
    const other = Buffer.from(candidate, 'utf8')

    return plaintext.length === other.length && timingSafeEqual(plaintext, other)
}

/** Clears the decoded key. Tests only — the key does not change at runtime. */
export const __resetEncryptionKey = (): void => {
    cachedKey = null
}
