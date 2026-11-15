// Petit serveur statique sans dépendance, pour lancer le jeu sur Railway (ou en local).
// Lancement : npm start  (puis http://localhost:3000)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = process.env.PORT || 3000;

// Fichiers du serveur lui-même : jamais servis au navigateur
const PRIVATE = new Set(['server.js', 'package.json']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const rel = urlPath === '/' ? 'index.html' : normalize(urlPath).replace(/^[/\\]+/, '');

    if (PRIVATE.has(rel)) {
      res.writeHead(404);
      return res.end('Not found');
    }

    const file = join(root, rel);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(port, () => {
  console.log(`Penalty & coup franc disponible sur le port ${port}`);
});
