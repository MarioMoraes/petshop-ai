import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
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
