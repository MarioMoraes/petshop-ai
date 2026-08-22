# Migrations — leia antes de rodar `prisma migrate dev`

Parte do schema deste projeto **não é expressável em `schema.prisma`** e por isso vive
em SQL escrito à mão dentro das migrations:

| Objeto | Onde | Por quê |
|---|---|---|
| Papéis `app_user` e `app_maintenance` | `*_rls_policies` | O Prisma não gerencia papéis do Postgres |
| Políticas RLS + `FORCE ROW LEVEL SECURITY` | `*_rls_policies` | Base do MOD-IDENT-07 |
| Função `current_tenant_id()` | `*_rls_policies` | Lê `app.tenant_id` da transação |
| Índices únicos **parciais** | `*_rls_policies` | O Prisma só declara unicidade total |
| Trigger append-only de `audit_logs` | `*_rls_policies` | PRD §9 |
| Defaults de `updated_at` | `*_updated_at_defaults` | `@updatedAt` é preenchido na aplicação |

## A pegadinha

`prisma migrate dev` compara o `schema.prisma` com o banco-sombra e **gera comandos
para remover tudo o que está na lista acima**, porque nada disso aparece no schema.

Portanto, ao criar uma migration nova:

```bash
pnpm --filter @petshop/db exec dotenv -e ../../.env -- \
  prisma migrate dev --create-only --name minha_mudanca
```

Depois **abra o arquivo gerado e apague** qualquer `DROP POLICY`, `DROP INDEX
idx_*`, `DROP TRIGGER`, `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` ou
`ALTER COLUMN ... DROP DEFAULT` que você não pediu. Só então aplique com
`prisma migrate deploy`.

## Toda tabela de negócio nova precisa de RLS

Ao adicionar uma tabela com `tenant_id`, acrescente na mesma migration:

```sql
ALTER TABLE "nova_tabela" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "nova_tabela" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "nova_tabela"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());
```

e inclua o nome do modelo em `RLS_MODELS`, em `packages/db/src/client.ts`, para que a
guarda de aplicação cubra a tabela junto com o banco.

## Senhas dos papéis

`app_user` e `app_maintenance` nascem com senha de desenvolvimento. Em staging e
produção, logo após `migrate deploy`:

```sql
ALTER ROLE app_user PASSWORD '<do secret manager>';
ALTER ROLE app_maintenance PASSWORD '<do secret manager>';
```
