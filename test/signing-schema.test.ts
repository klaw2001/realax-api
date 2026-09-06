/**
 * Proof that the phase 3 migration was applied, not merely written.
 *
 * A schema file can say `@unique` while the database has no such index — the
 * two only agree once a migration has actually run. The guarantees asserted
 * here are the ones the service delegates to the database precisely *because*
 * application code cannot make them: a check-then-act in
 * `createEnvelopeForForm` cannot stop two concurrent requests from both passing
 * the check, and a `findFirst` before inserting a `SignerEvent` cannot stop two
 * concurrent redeliveries from both inserting.
 *
 * No routes and no service code are involved. This is Prisma against Postgres.
 */

import { Prisma } from '@prisma/client'

import prisma from '../src/lib/prisma'
import { disconnect as disconnectRedis } from '../src/lib/redis'

const EMAIL = 'signing.schema.test.agent@realax.test'

let agentId = ''
let transactionId = ''
let formIdA = ''
let formIdB = ''

/** Whether an error was Prisma's unique-constraint violation. */
const isUniqueViolation = (error: unknown): boolean =>
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

/**
 * Assert a write was refused by a unique index.
 *
 * Written out rather than using `rejects.toMatchObject({ code: 'P2002' })`,
 * which would also pass for any object that happens to carry that field — the
 * point here is that Postgres refused the write, so the error class matters as
 * much as the code.
 */
const expectUniqueViolation = async (write: Promise<unknown>): Promise<void> => {
    await expect(write).rejects.toThrow()

    await write.catch((error: unknown) => {
        expect(isUniqueViolation(error)).toBe(true)
    })
}

beforeAll(async () => {
    const agent = await prisma.agent.upsert({
        where: { email: EMAIL },
        update: {},
        create: { email: EMAIL, name: 'Signing Schema Test Agent' }
    })

    agentId = agent.id

    // Child to parent, so a previous run leaves nothing behind.
    const owned = { agentId }
    await prisma.signerEvent.deleteMany({ where: { envelope: { transaction: owned } } })
    await prisma.signingEnvelope.deleteMany({ where: { transaction: owned } })
    await prisma.complianceCheck.deleteMany({ where: { transactionForm: { transaction: owned } } })
    await prisma.transactionForm.deleteMany({ where: { transaction: owned } })
    await prisma.transaction.deleteMany({ where: owned })

    const transaction = await prisma.transaction.create({
        data: { type: 'LISTING', agentId }
    })

    transactionId = transaction.id

    const template = await prisma.formTemplate.upsert({
        where: { formCode_revision: { formCode: 'SCHEMA-TEST', revision: 'test' } },
        update: {},
        create: {
            formCode: 'SCHEMA-TEST',
            revision: 'test',
            sourceSha256: 'not-a-real-hash',
            sourceS3Key: 'test/schema-test.pdf',
            fieldMap: {}
        }
    })

    const [a, b] = await Promise.all([
        prisma.transactionForm.create({
            data: { transactionId, formTemplateId: template.id, values: {} }
        }),
        prisma.transactionForm.create({
            data: { transactionId, formTemplateId: template.id, values: {} }
        })
    ])

    formIdA = a.id
    formIdB = b.id
})

afterAll(async () => {
    await prisma.signerEvent.deleteMany({ where: { envelope: { transaction: { agentId } } } })
    await prisma.signingEnvelope.deleteMany({ where: { transaction: { agentId } } })
    await prisma.transactionForm.deleteMany({ where: { transaction: { agentId } } })
    await prisma.transaction.deleteMany({ where: { agentId } })

    await Promise.all([disconnectRedis(), prisma.$disconnect()])
})

const envelope = (over: Record<string, unknown> = {}) => ({
    transactionId,
    externalId: `ext-${Math.random().toString(36).slice(2)}`,
    status: 'created',
    ...over
})

describe('one envelope out for signature per form', () => {
    it('refuses a second envelope claiming the same active form', async () => {
        await prisma.signingEnvelope.create({ data: envelope({ activeFormId: formIdA }) })

        await expectUniqueViolation(
            prisma.signingEnvelope.create({ data: envelope({ activeFormId: formIdA }) })
        )
    })

    it('lets two concurrent creates race, and exactly one wins', async () => {
        // The reason this constraint exists rather than a check in the service.
        // Both of these pass any check-then-act; only one can pass the index.
        const results = await Promise.allSettled([
            prisma.signingEnvelope.create({ data: envelope({ activeFormId: formIdB }) }),
            prisma.signingEnvelope.create({ data: envelope({ activeFormId: formIdB }) })
        ])

        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)

        const rejected = results.find(result => result.status === 'rejected')
        expect(isUniqueViolation((rejected as PromiseRejectedResult).reason)).toBe(true)
    })

    it('allows any number of envelopes with no active form', async () => {
        // A terminal envelope clears activeFormId, and Postgres permits many
        // NULLs under a unique constraint — which is what releases a form for a
        // fresh envelope after a decline.
        await prisma.signingEnvelope.create({ data: envelope({ activeFormId: null }) })
        await prisma.signingEnvelope.create({ data: envelope({ activeFormId: null }) })

        const dormant = await prisma.signingEnvelope.count({
            where: { transactionId, activeFormId: null }
        })

        expect(dormant).toBeGreaterThanOrEqual(2)
    })

    it('releases the form once the holder goes terminal', async () => {
        const holder = await prisma.signingEnvelope.findFirst({ where: { activeFormId: formIdA } })

        await prisma.signingEnvelope.update({
            where: { id: holder!.id },
            data: { status: 'declined', activeFormId: null }
        })

        // The whole point: a declined envelope must not block the next one.
        const replacement = await prisma.signingEnvelope.create({
            data: envelope({ activeFormId: formIdA })
        })

        expect(replacement.activeFormId).toEqual(formIdA)
    })
})

describe('a redelivered webhook is one event, not two', () => {
    it('refuses a second event with the same dedupe key', async () => {
        const created = await prisma.signingEnvelope.create({ data: envelope() })
        const dedupeKey = `dedupe-${created.id}`

        await prisma.signerEvent.create({
            data: { envelopeId: created.id, eventType: 'user.document.fieldinvite.sent', payload: {}, dedupeKey }
        })

        await expectUniqueViolation(
            prisma.signerEvent.create({
                data: { envelopeId: created.id, eventType: 'user.document.fieldinvite.sent', payload: {}, dedupeKey }
            })
        )

        expect(await prisma.signerEvent.count({ where: { dedupeKey } })).toEqual(1)
    })

    it('is unique globally, so a replay cannot be laundered through another envelope', async () => {
        const [first, second] = await Promise.all([
            prisma.signingEnvelope.create({ data: envelope() }),
            prisma.signingEnvelope.create({ data: envelope() })
        ])

        const dedupeKey = `dedupe-shared-${first.id}`

        await prisma.signerEvent.create({
            data: { envelopeId: first.id, eventType: 'user.document.complete', payload: {}, dedupeKey }
        })

        await expectUniqueViolation(
            prisma.signerEvent.create({
                data: { envelopeId: second.id, eventType: 'user.document.complete', payload: {}, dedupeKey }
            })
        )
    })
})

describe('columns the migration added', () => {
    it('stamps updatedAt, which the dashboard counts closings by', async () => {
        const created = await prisma.signingEnvelope.create({ data: envelope() })

        expect(created.updatedAt).toBeInstanceOf(Date)

        const moved = await prisma.signingEnvelope.update({
            where: { id: created.id },
            data: { status: 'sent' }
        })

        expect(moved.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime())
    })

    it('stores signers as our own shape, carrying no email and no name', async () => {
        const created = await prisma.signingEnvelope.create({
            data: envelope({
                signers: [{ transactionPartyId: 'party-1', role: 'SELLER', order: 1, externalRoleId: 'a'.repeat(40) }]
            })
        })

        const signers = created.signers as { transactionPartyId: string; externalRoleId: string }[]

        expect(signers[0]?.externalRoleId).toHaveLength(40)
        expect(JSON.stringify(signers)).not.toContain('@')
    })

    /*
     * Proves the migration ran, not merely that it was written. An envelope
     * created without a `delivery` has to read back `email`, because that is
     * what every envelope raised before 3.2 actually was — the default is a
     * statement about history, not a placeholder.
     */
    it('defaults delivery to email, which is what the rows that predate it were', async () => {
        const created = await prisma.signingEnvelope.create({ data: envelope() })

        expect(created.delivery).toEqual('email')
    })

    it('carries an invite id on an embedded envelope, and still no client detail', async () => {
        const created = await prisma.signingEnvelope.create({
            data: envelope({
                delivery: 'embedded',
                signers: [
                    {
                        transactionPartyId: 'party-1',
                        role: 'SELLER',
                        order: 1,
                        externalRoleId: 'a'.repeat(40),
                        externalInviteId: 'c'.repeat(40)
                    }
                ]
            })
        })

        const signers = created.signers as { externalInviteId?: string }[]

        expect(created.delivery).toEqual('embedded')
        expect(signers[0]?.externalInviteId).toHaveLength(40)

        // The extra vendor id changes nothing about rule 6.
        expect(JSON.stringify(signers)).not.toContain('@')
    })
})
