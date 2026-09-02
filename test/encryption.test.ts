import {
    DecryptionError,
    decryptField,
    encryptField,
    isEncrypted,
    matchesEncrypted
} from '../src/lib/encryption'

// Build plan 2.5. The data model has described `IdentityRecord.documentNumber`
// as encrypted at rest since 0.2 and nothing implemented it. This is the suite
// that makes the comment true.

const NUMBER = 'W1234-56789-01234'

describe('a field goes in and comes back', () => {
    test('a round trip returns exactly what was encrypted', () => {
        expect(decryptField(encryptField(NUMBER))).toEqual(NUMBER)
    })

    test('non-ASCII survives it', () => {
        const value = 'Ç4821-Ω-01234'

        expect(decryptField(encryptField(value))).toEqual(value)
    })

    test('an empty string is a legitimate value', () => {
        expect(decryptField(encryptField(''))).toEqual('')
    })
})

describe('what the ciphertext must not reveal', () => {
    test('the plaintext is not in it', () => {
        const stored = encryptField(NUMBER)

        expect(stored).not.toContain(NUMBER)
        expect(stored).not.toContain('W1234')

        // Nor in any obvious encoding of it.
        expect(stored).not.toContain(Buffer.from(NUMBER).toString('base64url'))
        expect(stored).not.toContain(Buffer.from(NUMBER).toString('hex'))
    })

    test('the same value encrypted twice does not look the same', () => {
        // A fresh IV per value. Deterministic encryption would let a leaked
        // table be searched for who holds a given document, which is most of
        // what encrypting it was for.
        expect(encryptField(NUMBER)).not.toEqual(encryptField(NUMBER))
    })

    test('two values under one key never share an IV', () => {
        const ivs = new Set(
            Array.from({ length: 200 }, () => encryptField(NUMBER).split('.')[1])
        )

        // Reusing an IV under GCM is not "weaker", it is broken: two values
        // encrypted under the same key and IV leak their XOR.
        expect(ivs.size).toEqual(200)
    })
})

describe('a value that has been tampered with', () => {
    test('a flipped byte in the ciphertext fails to decrypt rather than decrypting wrong', () => {
        const [version, iv, tag, ciphertext] = encryptField(NUMBER).split('.')
        const bytes = Buffer.from(ciphertext, 'base64url')
        bytes[0] ^= 0xff

        expect(() =>
            decryptField([version, iv, tag, bytes.toString('base64url')].join('.'))
        ).toThrow(DecryptionError)
    })

    test('a swapped authentication tag is refused', () => {
        const mine = encryptField(NUMBER).split('.')
        const other = encryptField('a different number').split('.')

        expect(() => decryptField([mine[0], mine[1], other[2], mine[3]].join('.'))).toThrow(
            DecryptionError
        )
    })

    test('a plaintext value stored in the column does not decrypt to itself', () => {
        // The failure mode this whole module exists to prevent: a column
        // labelled encrypted that quietly holds a licence number.
        expect(() => decryptField(NUMBER)).toThrow(DecryptionError)
    })

    test('an unknown format version is refused rather than guessed at', () => {
        const stored = encryptField(NUMBER).split('.')

        expect(() => decryptField(['v2', ...stored.slice(1)].join('.'))).toThrow(DecryptionError)
    })

    test('nothing about the value or the key reaches the error message', () => {
        try {
            decryptField(NUMBER)
            throw new Error('should not have decrypted')
        } catch (error) {
            expect((error as Error).message).not.toContain('W1234')
            expect((error as Error).message).not.toContain(NUMBER)
        }
    })
})

describe('recognising and comparing stored values', () => {
    test('a stored value is identifiable without decrypting it', () => {
        expect(isEncrypted(encryptField(NUMBER))).toEqual(true)
        expect(isEncrypted(NUMBER)).toEqual(false)
    })

    test('a candidate can be checked against a stored value', () => {
        const stored = encryptField(NUMBER)

        expect(matchesEncrypted(stored, NUMBER)).toEqual(true)
        expect(matchesEncrypted(stored, 'W1234-56789-01235')).toEqual(false)
        expect(matchesEncrypted(stored, '')).toEqual(false)
    })
})

describe('the stored format', () => {
    test('carries its version, so a key rotation can tell old values from new', () => {
        const stored = encryptField(NUMBER)

        expect(stored.startsWith('v1.')).toEqual(true)
        expect(stored.split('.')).toHaveLength(4)
    })

    test('is one column — the IV travels with the value it belongs to', () => {
        // An IV in a second column is one migration away from being separated
        // from the value it decrypts.
        expect(encryptField(NUMBER)).not.toContain('\n')
        expect(encryptField(NUMBER)).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]*$/)
    })
})
