/**
 * Cross-platform dev launcher.
 * Removes ELECTRON_RUN_AS_NODE (set by VS Code's terminal)
 * before spawning electron-vite, so Electron initializes properly.
 */
import { spawn } from 'child_process';

delete process.env.ELECTRON_RUN_AS_NODE;

const command = process.argv.includes('--preview') ? 'preview' : 'dev';

const child = spawn('npx', ['electron-vite', command], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: process.env,
  shell: true,
});

// Chromium's bundled DevTools spams CDP `Autofill.*` calls that Electron
// doesn't implement. The errors are harmless but drown out real output.
const NOISE = /Autofill\.(enable|setAddresses)/;

function pipeFiltered(src, dest) {
  let buf = '';
  src.setEncoding('utf8');
  src.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx + 1);
      buf = buf.slice(idx + 1);
      if (!NOISE.test(line)) dest.write(line);
    }
  });
  src.on('end', () => {
    if (buf && !NOISE.test(buf)) dest.write(buf);
  });
}

pipeFiltered(child.stdout, process.stdout);
pipeFiltered(child.stderr, process.stderr);

child.on('exit', (code) => process.exit(code ?? 0));
