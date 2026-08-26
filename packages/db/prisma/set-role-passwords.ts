/**
 * Troca as senhas de `app_user` e `app_maintenance` pelas do ambiente.
 *
 * A migration `20260822130000_rls_policies` cria as duas roles com senha igual ao
 * nome — bom para desenvolvimento, inaceitável em produção, e ela própria diz isso
 * no comentário. Como `CREATE ROLE` só roda na primeira aplicação da migration,
 * não há onde encaixar o valor real lá dentro: a senha tem que vir depois, de fora,
 * a cada deploy. É o que este script faz, e é idempotente.
 *
 * Roda no container `migrator` (infra/docker-compose.prod.yml), logo após
 * `prisma migrate deploy` e com a URL do owner — só ele pode alterar roles.
 */
import { PrismaClient } from '#prisma-client'

const ROLES = [
  { role: 'app_user', envVar: 'APP_USER_PASSWORD' },
  { role: 'app_maintenance', envVar: 'APP_MAINTENANCE_PASSWORD' },
] as const

/**
 * `ALTER ROLE ... PASSWORD` não aceita parâmetro ligado — o valor entra no texto do
 * comando. Em vez de escapar aspas e torcer, exigimos um alfabeto seguro e
 * recusamos qualquer coisa fora dele: a senha é gerada por nós, não digitada.
 */
const SAFE = /^[A-Za-z0-9._~-]{16,}$/

async function main() {
  const prisma = new PrismaClient()
  try {
    for (const { role, envVar } of ROLES) {
      const senha = process.env[envVar]
      if (!senha) {
        throw new Error(`${envVar} não está definida — a role ${role} ficaria com a senha de desenvolvimento.`)
      }
      if (!SAFE.test(senha)) {
        throw new Error(
          `${envVar} precisa ter ao menos 16 caracteres de [A-Za-z0-9._~-]. ` +
            `Gere com: openssl rand -base64 32 | tr -d '/+=' `,
        )
      }
      await prisma.$executeRawUnsafe(`ALTER ROLE ${role} PASSWORD '${senha}'`)
      console.log(`senha de ${role} atualizada`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((erro) => {
  console.error(erro instanceof Error ? erro.message : erro)
  process.exit(1)
})
