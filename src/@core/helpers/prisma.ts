// Kept as a re-export so the starter's `@core/helpers/prisma` import path still
// resolves to the one client in `src/lib/prisma.ts` rather than opening a
// second connection pool. New code should import `@/lib/prisma` directly.
export { default } from '@/lib/prisma'
