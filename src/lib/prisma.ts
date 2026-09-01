import { PrismaClient } from '@prisma/client'

/**
 * The single Prisma client for the service. One instance means one connection
 * pool; importing `@prisma/client` and calling `new PrismaClient()` a second
 * time anywhere else opens a second pool against the same database.
 */
const prisma = new PrismaClient()

export default prisma
