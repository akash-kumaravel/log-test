import * as esbuild from 'esbuild';
import { cpSync, rmSync, existsSync, mkdirSync, watch, statSync, createReadStream, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { execSync } from 'child_process';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');
const isProd = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');
function cleanDistBuildOutputs() {
  if (!existsSync('dist')) return;
  for (const entry of [
    'app.js',
    'index.html',
    'app.css',
    'video-app.js',
    'workers'
  ]) {
    const target = join('dist', entry);
    if (existsSync(target)) rmSync(target, { recursive: true });
  }
}

const copyAssetsPlugin = {
  name: 'copy-assets',
  setup(build) {
    build.onEnd(() => {
      console.log('📂 Syncing static assets...');
      try {
        cpSync('public', 'dist', { recursive: true });
      } catch (err) {
        console.error('❌ Asset copy failed:', err);
      }
    });
  },
};

const commonConfig = {
  bundle: true,
  loader: { '.png': 'dataurl' },
  minify: isProd,
  logLevel: 'info',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const findAvailablePort = (startPort, maxAttempts = 20) => new Promise((resolvePort, reject) => {
  const tryPort = (port, remaining) => {
    const probe = createNetServer();
    probe.once('error', (err) => {
      probe.close();
      if (err.code === 'EADDRINUSE' && remaining > 0) {
        tryPort(port + 1, remaining - 1);
        return;
      }
      reject(err);
    });
    probe.once('listening', () => {
      probe.close(() => resolvePort(port));
    });
    probe.listen(port, '0.0.0.0');
  };
  tryPort(startPort, maxAttempts);
});

async function serveStaticDevDist(rootDir = 'dist', defaultPort = 3000) {
  const distRoot = resolve(rootDir);
  const startPort = Number(process.env.PORT || defaultPort);
  const port = await findAvailablePort(startPort);

  const server = createServer((req, res) => {
    let urlPath = '/';
    try {
      urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }
    // One page for photos and videos: `/` is the app.
    const devHarnessPath = '/index.html';
    const requestPath =
      urlPath === '/' || urlPath === ''
        ? devHarnessPath
        : urlPath;
    const fsPath = resolve(join(distRoot, normalize(requestPath)));

    if (!fsPath.startsWith(distRoot)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    const requestedExt = extname(requestPath).toLowerCase();
    const isSpaRoute = requestedExt === '';
    let targetPath = fsPath;
    const targetExists = existsSync(targetPath);
    const targetIsDir = targetExists && statSync(targetPath).isDirectory();

    if ((!targetExists || targetIsDir) && isSpaRoute) {
      targetPath = resolve(join(distRoot, 'index.html'));
    }

    if (!existsSync(targetPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = extname(targetPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin'
    });
    createReadStream(targetPath).pipe(res);
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`🌐 Dev server running at http://0.0.0.0:${port}`);
    console.log(`   ↳ photos + videos:        http://0.0.0.0:${port}/`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Build website - app.js
const websiteCtx = await esbuild.context({
  ...commonConfig,
  entryPoints: ['src/app.js'],
  outfile: 'dist/app.js',
  platform: 'browser',
  target: ['es2020'],
  sourcemap: !isProd,
  plugins: [copyAssetsPlugin],
});

const videoWebsiteCtx = await esbuild.context({
  ...commonConfig,
  entryPoints: ['src/video-app.js'],
  outfile: 'dist/video-app.js',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: !isProd,
});

// Build website worker
const workerCtx = await esbuild.context({
  ...commonConfig,
  entryPoints: ['src/workers/watermarkWorker.js'],
  outfile: 'dist/workers/watermark-worker.js',
  platform: 'browser',
  format: 'esm',
  target: ['es2020'],
  sourcemap: !isProd,
});

console.log(`🚀 Starting build process... [${isProd ? 'PRODUCTION' : 'DEVELOPMENT'}]`);

cleanDistBuildOutputs();
mkdirSync('dist/workers', { recursive: true });

if (isProd) {
  await Promise.all([
    websiteCtx.rebuild(),
    videoWebsiteCtx.rebuild(),
    workerCtx.rebuild()
  ]);
  console.log('✅ Build complete!');
  process.exit(0);
} else {
  await Promise.all([
    websiteCtx.watch(),
    videoWebsiteCtx.watch(),
    workerCtx.watch()
  ]);

  const watchDir = (dir, dest) => {
    let debounceTimer = null;

    watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      if (debounceTimer) clearTimeout(debounceTimer);

      debounceTimer = setTimeout(() => {
        console.log(`📂 Asset changed: ${filename}`);
        try {
          cpSync(dir, dest, { recursive: true });
        } catch (e) {
          console.error('Sync failed:', e);
        }
      }, 100);
    });
  };
  watchDir('public', 'dist');

  await serveStaticDevDist('dist');

  console.log('👀 Watching for changes...');
}
