import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const root = 'dist';
const port = Number(process.env.PORT || 3000);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  let path = normalize(url.pathname).replace(/^\/+/, '');
  if (!path || path.endsWith('/')) path = join(path, 'index.html');
  let file = join(root, path);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Serving ${root}/ at http://localhost:${port}/`));
