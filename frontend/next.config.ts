import path from 'node:path'
import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
  /**
   * Saída autocontida para a imagem de produção (infra/Dockerfile, alvo
   * `frontend`): o Next copia para `standalone/` só os arquivos de node_modules
   * que o servidor realmente carrega. Sem isto a imagem carregaria o
   * node_modules inteiro do monorepo — mais de 1 GB para servir umas dezenas de
   * rotas. Não afeta `next dev` nem `next start` locais, que continuam lendo o
   * distDir normal; é um diretório a mais gerado no build.
   */
  output: 'standalone',
  /** O contexto do build é a raiz do monorepo, não `frontend/`. */
  outputFileTracingRoot: path.join(import.meta.dirname, '..'),
  /**
   * `next dev` e `next build` compartilham `.next` por padrão — e um build rodando
   * com o dev server de pé sobrescreve os assets que ele está servindo, deixando a
   * página sem CSS até reiniciar. O `build` e o `start` apontam para um diretório
   * próprio via `NEXT_DIST_DIR` (ver package.json); o dev fica com o padrão.
   */
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // Os pacotes do monorepo são consumidos como TypeScript, sem passo de build.
  transpilePackages: ['@petshop/shared-types', '@petshop/api-client'],
  typedRoutes: true,
  /**
   * Os endereços que mudaram quando o Financeiro juntou o dinheiro num lugar só
   * (2026-09-26): a Cobrança era um item próprio do menu, e os Pacotes, uma aba do
   * Financeiro. Favorito, link colado numa conversa e aba aberta de ontem
   * continuam chegando. O redirect roda antes do middleware, então o roteamento por
   * host vale no destino.
   */
  async redirects() {
    return [
      { source: '/cobranca', destination: '/financeiro/relatorios', permanent: true },
      {
        source: '/cobranca/:path*',
        destination: '/financeiro/relatorios/:path*',
        permanent: true,
      },
      { source: '/financeiro/pacotes', destination: '/configuracoes/pacotes', permanent: true },
    ]
  },
  experimental: {
    serverActions: {
      // `uploadPhotosAction` (MOD-PET-04) recebe o FormData inteiro na Server Action
      // antes de qualquer validação nossa rodar. O padrão do Next é 1 MB, bem abaixo
      // do que MAX_PHOTO_BYTES × MAX_PHOTOS_PER_UPLOAD (shared-types/pet.ts) permite:
      // 10 MB por foto, até 10 fotos por envio. Sem isto o upload morre com "Body
      // exceeded 1 MB limit" antes mesmo de chegar ao gateway.
      bodySizeLimit: '100mb',
    },
  },
  webpack: (webpackConfig) => {
    // O código dos pacotes usa import ESM com extensão (`./identity.js`), que é o
    // que o TypeScript emite. O webpack precisa saber que o arquivo real é `.ts`.
    webpackConfig.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    }
    return webpackConfig
  },
}

export default config
