import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { resolveStateDir } from '../utils/config';

export class JsonStateStore<T> {
  constructor(
    readonly path: string,
    private readonly initial: () => T,
  ) {}

  load(): T {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as T;
    } catch {
      return this.initial();
    }
  }

  save(value: T): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

export function hskStatePath(name: string, env = process.env): string {
  return join(resolveStateDir(env), 'hsk', name);
}

