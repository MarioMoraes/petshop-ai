import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
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
