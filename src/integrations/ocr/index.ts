import { env } from '@/config/env'
import { azureProvider } from '@/integrations/ocr/azure.client'
import { barcodeProvider } from '@/integrations/ocr/barcode.client'
import { mockProvider } from '@/integrations/ocr/mock.client'
import { type OcrProvider } from '@/integrations/ocr/provider'
import { textractProvider } from '@/integrations/ocr/textract.client'

/**
 * The configured OCR provider.
 *
 * One name to change, and the enum in `env.ts` makes an unknown one fail on
 * boot rather than at the first upload. `env.ts` also refuses anything but
 * Textract under `NODE_ENV=production` — a free development reader silently
 * serving real clients is the failure mode worth designing out.
 *
 * This lives beside the implementations rather than inside one of them so that
 * adding a provider does not mean editing another provider's file. The switch
 * is exhaustive over the enum, so widening `OCR_PROVIDER` without writing the
 * client is a compile error here rather than a 502 the first time an agent
 * photographs a licence — which is why `gemini` is not in the enum yet.
 */
export const ocrProvider = (): OcrProvider => {
    switch (env.OCR_PROVIDER) {
        case 'textract':
            return textractProvider
        case 'azure':
            return azureProvider
        case 'mock':
            return mockProvider
        case 'barcode':
            return barcodeProvider
    }
}
