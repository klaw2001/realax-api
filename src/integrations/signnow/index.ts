import { env } from '@/config/env'
import { mockProvider } from '@/integrations/signnow/mock.client'
import { type SignNowProvider } from '@/integrations/signnow/provider'
import { signNowHttpProvider } from '@/integrations/signnow/signnow.client'

/**
 * The configured e-sign provider.
 *
 * One name to change, and the enum in `env.ts` makes an unknown one fail on
 * boot rather than at the first Send. `env.ts` also refuses anything but the
 * real vendor under `NODE_ENV=production`: a mock that reports an Agreement of
 * Purchase and Sale as sent when nothing left the building is the failure mode
 * worth designing out.
 *
 * This lives beside the implementations rather than inside one of them, so
 * adding a provider does not mean editing another provider's file. The switch
 * is exhaustive over the enum, so widening `SIGNNOW_PROVIDER` without writing
 * the client is a compile error here rather than a 502 the first time an agent
 * sends a contract.
 */
export const signNowProvider = (): SignNowProvider => {
    switch (env.SIGNNOW_PROVIDER) {
        case 'signnow':
            return signNowHttpProvider
        case 'mock':
            return mockProvider
    }
}
