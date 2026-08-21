import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

const ANALYZE_BUNDLE = process.env.ANALYZE === 'true';
const CONFIG_DIR = import.meta.dirname;

const rootPkg = JSON.parse(readFileSync(resolve(CONFIG_DIR, '../package.json'), 'utf-8'));

// Which commit this BUNDLE was built from (#4694). package.json's version cannot
// answer that — by project rule it reflects the last RELEASE and is identical
// across every development commit — so a dist/ built three days ago looks exactly
// like one built this minute. The client compares this against the server's
// /api/system/health/details `build.commit` and flags a mismatch, which is the
// "I spent an hour debugging a UI that was not talking to the code I edited"
// failure mode.
//
// Fail-soft: a source-tarball build has no .git and must still build, so every
// probe degrades to 'unknown' rather than throwing.
function gitStamp(args) {
  const out = execFileSync('git', args, {
    cwd: CONFIG_DIR,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000
  });
  return out.trim() || 'unknown';
}

function buildStamp() {
  // 'unknown' rather than '' or null: this value is inlined into the bundle as a
  // literal, and an empty string would compare unequal to every real commit and
  // report a permanent false "stale bundle" (root CLAUDE.md's absent-vs-empty rule).
  let commit = 'unknown';
  let branch = 'unknown';
  try {
    commit = gitStamp(['rev-parse', '--short=7', 'HEAD']);
    const head = gitStamp(['rev-parse', '--abbrev-ref', 'HEAD']);
    branch = head === 'HEAD' ? 'unknown' : head;
  } catch {
    // No git, no repo, or a timeout — keep the 'unknown' defaults.
  }
  // Commit / branch / timestamp only. No paths (they embed the OS username), no
  // hostname — this string ships to every browser that loads the app.
  return { commit, branch, builtAt: new Date().toISOString() };
}

// Dev proxy target: probe for the self-signed/LE cert under data/certs/. If the
// server is running HTTPS, the dev proxy must target HTTPS too (or requests
// through Vite return "socket hang up"). `secure: false` accepts the cert
// whether it's the trusted LE one or the self-signed fallback.
const CERT_PATH = resolve(CONFIG_DIR, '..', 'data', 'certs', 'cert.pem');
const API_SCHEME = existsSync(CERT_PATH) ? 'https' : 'http';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const API_HOST = env.VITE_API_HOST || 'localhost';
  const API_TARGET = `${API_SCHEME}://${API_HOST}:5555`;

  return {
    define: {
      __APP_VERSION__: JSON.stringify(rootPkg.version),
      __BUILD_STAMP__: JSON.stringify(buildStamp())
    },
    plugins: [
      react(),
      ANALYZE_BUNDLE && visualizer({
        filename: 'dist/bundle-report.html',
        gzipSize: true,
        brotliSize: true,
        template: 'treemap',
      }),
    ].filter(Boolean),
    server: {
      host: '0.0.0.0',
      port: 5554,
      // Fail loudly if 5554 is taken instead of auto-incrementing. Without this,
      // Vite walks up to the next free port and can land on a reserved PortOS
      // port (5555 API, 5556 browser CDP) — squatting on the CDP port makes the
      // browser keep-alive read Vite's HTML index and spam JSON-parse errors.
      strictPort: true,
      open: false,
      allowedHosts: ['.ts.net', 'localhost'],
      proxy: {
        '/api': {
          target: API_TARGET,
          changeOrigin: true,
          secure: false
        },
        // Every `/data/**` asset mount at once, instead of a hand-maintained
        // list that silently fell behind the server's (see docs/PORTS.md:
        // an unproxied `/data` path is answered by Vite's SPA fallback with
        // index.html and a 200, so a binary loader parses HTML). Anchored as a
        // regex on purpose: Vite matches a plain context with a bare
        // `url.startsWith`, so a `'/data'` key would also swallow the `/data`
        // (Data Manager) and `/datadog` client routes and hand them the API's
        // stale built index.html. `scripts/dev-proxy-drift.test.js` holds both
        // halves of that — mounts covered, client routes untouched.
        '^/data/': {
          target: API_TARGET,
          changeOrigin: true,
          secure: false
        },
        '/socket.io': {
          target: API_TARGET,
          changeOrigin: true,
          ws: true,
          secure: false
        }
      }
    },
    build: {
      rolldownOptions: {
        output: {
          // Vite 8 ships the rolldown bundler, whose canonical chunking API is
          // `output.codeSplitting.groups` — each group captures the modules whose
          // id matches `test` into a named chunk. This replaces the legacy
          // `rollupOptions.output.manualChunks` function (still accepted via
          // rolldown's compat layer, but slated to drop in a future Vite). The
          // groups below reproduce the same four vendor chunks as before.
          // Note: use `[\\/]` (not `/`) for the path separator so the regexes
          // also match on Windows.
          codeSplitting: {
            groups: [
              // Core React dependencies
              { name: 'vendor-react', test: /[\\/]node_modules[\\/](react|react-dom|react-router)[\\/]/ },
              // Socket dependencies
              { name: 'vendor-realtime', test: /[\\/]node_modules[\\/]socket\.io-client[\\/]/ },
              // Drag and drop library (only used in CoS)
              { name: 'vendor-dnd', test: /[\\/]node_modules[\\/]@dnd-kit[\\/]/ },
              // Icon library (largest dependency)
              { name: 'vendor-icons', test: /[\\/]node_modules[\\/]lucide-react[\\/]/ },
              // 3D stack — only pulled into lazy 3D pages (CyberCity, avatars,
              // BrainGraph). Naming it gives the ~1 MB chunk a stable identity
              // instead of an opaque `OrbitControls-*.js` and guarantees a single
              // shared chunk across all 3D consumers.
              { name: 'vendor-three', test: /[\\/]node_modules[\\/](three|@react-three|three-fenestra)[\\/]/ },
              // Charting (recharts) — lazy chart pages only
              { name: 'vendor-charts', test: /[\\/]node_modules[\\/](recharts|d3-[^\\/]+|victory-[^\\/]+)[\\/]/ },
              // Terminal emulator (xterm) — Shell page only
              { name: 'vendor-term', test: /[\\/]node_modules[\\/]@xterm[\\/]/ },
            ]
          }
        }
      },
      // Enable source maps for debugging in production
      sourcemap: false,
      // Increase chunk size warning limit (icons are large)
      chunkSizeWarningLimit: 600
    }
  };
});
