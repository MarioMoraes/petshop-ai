// Confere que todo alvo `petshop-dist` do campo `exports` existe de verdade.
//
// ── Por que isto precisa existir ──────────────────────────────────────────────
// Cada `packages/*/package.json` publica duas resoluções para o mesmo módulo:
//
//   "exports": { ".": { "petshop-dist": "./dist/src/index.js",
//                       "default":      "./src/index.ts" } }
//
// Em desenvolvimento vale sempre a `default` — o TypeScript de origem. A
// `petshop-dist` só é escolhida quando `NODE_OPTIONS=--conditions=petshop-dist`
// está no ambiente, e isso acontece em UM lugar só: dentro da imagem de produção.
//
// A consequência é que um caminho errado ali é invisível para a suíte inteira, para
// o `pnpm dev` e para o `tsc`. Ele aparece pela primeira vez no container, como
// ERR_MODULE_NOT_FOUND no primeiro import — e, com `order: start-first`, aparece
// depois de o deploy já ter começado a substituir o container que funcionava.
//
// Foi exatamente o que aconteceu: três pacotes tinham `rootDir: "src"` (emitindo
// `dist/index.js`) enquanto o `exports` prometia `dist/src/index.js`. Os dez
// serviços subiam e morriam no primeiro import.
//
// Roda no estágio `build` do infra/Dockerfile, com os `dist` recém-emitidos.

import { readFileSync, existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pacotesDir = join(raiz, 'packages');

const problemas = [];
let conferidos = 0;

for (const nome of readdirSync(pacotesDir)) {
  const pkgPath = join(pacotesDir, nome, 'package.json');
  if (!existsSync(pkgPath)) continue;

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (!pkg.exports) continue;

  for (const [subpath, mapa] of Object.entries(pkg.exports)) {
    // Entradas simples (uma string, sem condições) não têm `petshop-dist`.
    if (typeof mapa !== 'object' || mapa === null) continue;

    const alvo = mapa['petshop-dist'];
    if (!alvo) continue;

    conferidos++;
    const arquivo = join(pacotesDir, nome, alvo);
    if (!existsSync(arquivo)) {
      problemas.push(`  @petshop/${nome} "${subpath}" → ${alvo} (não existe)`);
    }
  }
}

if (problemas.length > 0) {
  console.error(
    `\nverificar-exports: ${problemas.length} de ${conferidos} alvos petshop-dist não existem:\n`,
  );
  console.error(problemas.join('\n'));
  console.error(
    '\nCompare o `exports` do package.json com o que o `tsc` realmente emitiu.',
  );
  console.error(
    'Causa mais comum: `rootDir: "src"` no tsconfig emite `dist/index.js`,',
  );
  console.error('enquanto `rootDir: "."` emite `dist/src/index.js`.\n');
  process.exit(1);
}

console.log(`verificar-exports: ${conferidos} alvos petshop-dist conferidos.`);
