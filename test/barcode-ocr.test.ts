import jpeg from 'jpeg-js'

const getObjectBytes = jest.fn<Promise<Buffer>, [string]>()

jest.mock('../src/lib/s3', () => ({
    __esModule: true,
    getObjectBytes: (key: string) => getObjectBytes(key)
}))

/*
 * Imported after the mock is declared. `jest.mock` is hoisted above the imports
 * either way, but the ordering here is what makes that legible rather than
 * something a reader has to know about Jest to follow.
 */
import { barcodeProvider } from '../src/integrations/ocr/barcode.client'
import { OcrError } from '../src/integrations/ocr/provider'

/**
 * The barcode reader's failure paths (UX plan item 10).
 *
 * The success path cannot be tested here: zxing-js ships no PDF417 encoder, so
 * there is no way to synthesise a barcode to decode. What *can* be pinned is
 * how each failure is classified, and that matters — the service treats
 * `unreadable` and `unavailable` completely differently, and getting it wrong
 * either tells an agent to retry something no retry fixes, or quietly turns an
 * outage into a manual-entry form.
 */

const REQUEST = { s3Key: 'transactions/tx_1/ids/p_1/licence.jpg', declaredType: 'drivers_licence' as const }

/** A plain image with no barcode in it — what the front of a licence looks like. */
const blankJpeg = (width = 160, height = 120): Buffer => {
    const data = Buffer.alloc(width * height * 4, 0xff)

    return Buffer.from(jpeg.encode({ data, width, height }, 80).data)
}

beforeEach(() => {
    getObjectBytes.mockReset()
})

describe('a photograph with no barcode in it', () => {
    test('is the agent’s to fix, and says which side of the card to photograph', async () => {
        getObjectBytes.mockResolvedValue(blankJpeg())

        const error = await barcodeProvider.scanIdentityDocument(REQUEST).catch((thrown: unknown) => thrown)

        expect(error).toBeInstanceOf(OcrError)
        expect((error as OcrError).kind).toEqual('unreadable')

        // This is the failure an agent will actually hit — they photograph the
        // front, because nobody told them otherwise.
        expect((error as OcrError).message).toContain('back of the licence')
    })
})

describe('a file that is not a JPEG', () => {
    test('is unreadable rather than an outage', async () => {
        getObjectBytes.mockResolvedValue(Buffer.from('this is not an image'))

        const error = await barcodeProvider.scanIdentityDocument(REQUEST).catch((thrown: unknown) => thrown)

        expect((error as OcrError).kind).toEqual('unreadable')
        expect((error as OcrError).message).toContain('JPEG')
    })
})

describe('the stored document being unreachable', () => {
    test('is an outage, which is worth retrying', async () => {
        getObjectBytes.mockRejectedValue(new Error('connection reset'))

        const error = await barcodeProvider.scanIdentityDocument(REQUEST).catch((thrown: unknown) => thrown)

        expect((error as OcrError).kind).toEqual('unavailable')
    })

    test('and never puts the key in the message', async () => {
        getObjectBytes.mockRejectedValue(new Error('connection reset'))

        const error = await barcodeProvider.scanIdentityDocument(REQUEST).catch((thrown: unknown) => thrown)

        // Rule 6: an S3 key for an ID scan never reaches a log line or an error.
        expect((error as OcrError).message).not.toContain('transactions/tx_1')
    })
})

describe('the reader reads from where the document is stored', () => {
    test('by key, not by bytes handed to it', async () => {
        getObjectBytes.mockResolvedValue(blankJpeg())

        await barcodeProvider.scanIdentityDocument(REQUEST).catch(() => undefined)

        // The record has to be provably about the object under Object Lock.
        expect(getObjectBytes).toHaveBeenCalledWith(REQUEST.s3Key)
    })
})
