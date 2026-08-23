import { PrismaClient } from '../generated/client/index.js'
import { seedCatalog } from '../src/seed-catalog.js'
import { seedRbac } from '../src/seed-rbac.js'

/** CLI do seed. A lógica vive em `src/seed-rbac.ts`, para os testes chamarem direto. */

const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL,
})

seedRbac(prisma)
  .then(async (rbac) => ({ ...rbac, ...(await seedCatalog(prisma)) }))
  .then((counts) => {
    console.log(
      JSON.stringify({ level: 'info', msg: 'seed de RBAC e catálogo concluído', ...counts }),
    )
  })
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
