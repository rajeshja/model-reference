import { mkdir, cp } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
for (const file of ['index.html']) await cp(file, `dist/${file}`);

await mkdir('dist/src', { recursive: true });
for (const file of ['src/main.js', 'src/styles.css']) await cp(file, `dist/${file}`);

await mkdir('dist/defaults', { recursive: true });
await cp('defaults/models.json', 'dist/defaults/models.json');

console.log('Built static app to dist/');
