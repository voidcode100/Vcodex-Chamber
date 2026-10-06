import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/** Vite may extract common CSS when the chat and teleprompter share modules. */
export function webviewStyles(buildDirectory: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(path.join(buildDirectory, '.vite', 'manifest.json'), 'utf8')) as Record<string, { css?: string[]; imports?: string[]; dynamicImports?: string[] }>;
    const visited = new Set<string>();
    const css = new Set<string>();
    const visit = (key: string) => {
      if (visited.has(key)) return;
      visited.add(key);
      const entry = manifest[key];
      if (!entry) return;
      for (const imported of [...entry.imports ?? [], ...entry.dynamicImports ?? []]) visit(imported);
      for (const file of entry.css ?? []) css.add(file);
    };
    visit('index.html');
    return [...css];
  } catch { return ['assets/renderVSCodeApp.css']; }
}
