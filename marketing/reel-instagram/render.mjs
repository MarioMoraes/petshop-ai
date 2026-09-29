import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'

const [mode = 'frames', ...rest] = process.argv.slice(2)
const exe = path.join(process.env.HOME, 'Library/Caches/ms-playwright/chromium-1217/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
const browser = await chromium.launch({ executablePath: exe })
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.error('pageerror', e.message))
await page.goto('file://' + path.resolve('reel.html'))
await page.evaluate(() => window.ready)

if (mode === 'frames') {
  for (const t of rest.map(Number)) {
    await page.evaluate((t) => window.renderAt(t), t)
    await page.screenshot({ path: `shots/t${String(t).padStart(5, '0')}.png` })
  }
} else {
  const FPS = 60, DUR = await page.evaluate(() => DURATION), out = rest[0] || 'reel.mp4'
  const ff = spawn(ffmpegPath, ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.2',
    '-r', String(FPS), '-movflags', '+faststart', '-an', out], { stdio: ['pipe', 'ignore', 'inherit'] })
  const total = FPS * DUR
  for (let f = 0; f < total; f++) {
    await page.evaluate((t) => window.renderAt(t), f / FPS)
    const buf = await page.screenshot({ type: 'png' })
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r))
    if (f % 300 === 0) console.log('frame', f, '/', total)
  }
  ff.stdin.end()
  await new Promise((r) => ff.on('close', r))
}
await browser.close()
