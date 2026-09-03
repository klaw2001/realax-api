import {
    BinaryBitmap,
    DecodeHintType,
    HybridBinarizer,
    PDF417Reader,
    RGBLuminanceSource
} from '@zxing/library'
import jpeg from 'jpeg-js'

import { parseAamva } from '@/integrations/ocr/aamva'
import {
    OcrError,
    type OcrProvider,
    type ScanRequest,
    type ScannedIdentity
} from '@/integrations/ocr/provider'
import logger from '@/lib/logger'
import { getObjectBytes } from '@/lib/s3'

/**
 * The PDF417 barcode on the back of a driver's licence (UX plan item 10).
 *
 * **The only reader here that is not a best effort.** Every other provider
 * recognises printed characters and can be wrong about any of them; this one
 * decodes text the issuing authority encoded and reads it back verbatim. It is
 * free forever, needs no account, works offline, and the document never leaves
 * the process — which makes it the only option that is residency-safe by
 * construction rather than by choosing a region.
 *
 * ## What it cannot do
 *
 * It needs the **back** of the card. A photograph of the front — which is what
 * an agent takes if nobody tells them otherwise — contains no barcode and
 * yields nothing. That is the whole reason this is not simply the default
 * reader, and why the plan describes it as a cross-check rather than a
 * replacement.
 *
 * It also cannot read a passport. Passports carry a machine readable zone, not
 * a PDF417, and nothing here decodes one.
 *
 * ## Why the decoding is pure JavaScript
 *
 * `jpeg-js` and `@zxing/library` both run in-process with no native binary and
 * no service. A native image library would be faster and would drag a build
 * toolchain into every deployment of this API for a development reader.
 *
 * ## Honest about its failure rate
 *
 * Getting a barcode out of a phone photograph is the hard half: it wants the
 * card square to the lens, in focus, filling most of the frame, and evenly lit.
 * A failure here is `unreadable` — the agent takes a better photograph, or uses
 * a different reader — and never `unavailable`, because nothing was unavailable.
 */

/** PNG is accepted by the upload path; only JPEG is decoded here. */
const decodePixels = (bytes: Buffer) => {
    try {
        // `useTArray` returns a Uint8Array rather than a Buffer, which is what
        // the luminance source expects.
        return jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 128 })
    } catch {
        return null
    }
}

/**
 * RGBA from the decoder, packed the way `RGBLuminanceSource` wants it.
 *
 * It takes 32-bit ARGB integers, not the RGBA byte array `jpeg-js` produces, so
 * the repack is not optional — handing it the raw array reads the alpha channel
 * as red and finds no barcode in anything.
 */
const toLuminance = (data: Uint8Array, width: number, height: number) => {
    const packed = new Int32Array(width * height)

    for (let index = 0; index < packed.length; index += 1) {
        const at = index * 4

        packed[index] = (data[at] << 16) | (data[at + 1] << 8) | data[at + 2]
    }

    return new RGBLuminanceSource(packed, width, height)
}

const HINTS = new Map<DecodeHintType, unknown>([[DecodeHintType.TRY_HARDER, true]])

/** The barcode implementation of the OCR boundary. */
export const barcodeProvider: OcrProvider = {
    name: 'barcode',

    async scanIdentityDocument({ s3Key, declaredType }: ScanRequest): Promise<ScannedIdentity> {
        let bytes: Buffer

        try {
            bytes = await getObjectBytes(s3Key)
        } catch (error) {
            // The key names an identity scan and rule 6 keeps those out of logs.
            logger.error('barcode read: could not fetch the stored document', {
                name: (error as Error).name
            })

            throw new OcrError('unavailable', 'The document reader is unavailable', error)
        }

        const image = decodePixels(bytes)

        if (image === null) {
            throw new OcrError(
                'unreadable',
                'That image could not be decoded. The barcode reader takes JPEG photographs.'
            )
        }

        const bitmap = new BinaryBitmap(
            new HybridBinarizer(toLuminance(image.data, image.width, image.height))
        )

        let text: string

        try {
            text = new PDF417Reader().decode(bitmap, HINTS).getText()
        } catch {
            // Not an outage and not a misconfiguration: there is no barcode in
            // this image, which is what a photograph of the *front* of a licence
            // looks like to this reader.
            throw new OcrError(
                'unreadable',
                'No barcode was found. Photograph the back of the licence, square to the camera and filling the frame.'
            )
        }

        const scanned = parseAamva(text, declaredType)

        if (scanned === null) {
            throw new OcrError(
                'unreadable',
                'That barcode is not an identity document.'
            )
        }

        // Names only, never values — the barcode carries a licence number and
        // rule 6 is that those never reach a log line.
        logger.info('identity document read', {
            provider: scanned.provider,
            modelVersion: scanned.modelVersion,
            fields: Object.entries(scanned)
                .filter(([, item]) => typeof item === 'string' && item !== '')
                .map(([name]) => name)
                .filter(name => name !== 'documentNumber')
        })

        return scanned
    }
}
