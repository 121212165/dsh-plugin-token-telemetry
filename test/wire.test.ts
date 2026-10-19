/**
 * Wire-level (assembly layer) tests for the prebuilt token-telemetry package.
 * The plugin ships prebuilt artifacts only (no src), so these mount the
 * surface the way the dsh host would: resolve package.json "main", dynamic
 * import it, and drive apply() against a scripted host context. The browser
 * half is wired through exports["./client"] and the dsh.client manifest —
 * both paths are asserted here without loading a UI runtime.
 * @module test/wire
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const here = join(fileURLToPath(import.meta.url), '..');
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
  main: string;
  types: string;
  exports: Record<string, { default?: string }>;
  dsh?: { client?: { platform?: string; immediately?: boolean } };
};

interface HostCtx {
  /** lib/index.js touches ctx.logger?.info?.() without invoking a factory,
   *  so the host context carries the logger object directly. */
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  commands?: { register: (definition: unknown) => void };
  tools?: { register: (definition: unknown) => void };
  on?: (event: string, callback: (...args: unknown[]) => unknown) => void;
}

/** Mount exactly like the host: import the resolved package main entry. */
async function importHostHalf(): Promise<{ apply: Function }> {
  const mainFile = resolve(join(here, '..', pkg.exports['.']!.default!));
  return (await import(pathToFileURL(mainFile).href)) as { apply: Function };
}

function makeCtx() {
  const logs: string[] = [];
  const registered: string[] = [];
  const listeners: string[] = [];
  const ctx: HostCtx = {
    logger: {
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(`[warn] ${message}`),
    },
    commands: { register: (definition: unknown) => registered.push((definition as { name?: string })?.name ?? 'unknown') },
    tools: { register: (definition: unknown) => registered.push((definition as { name?: string })?.name ?? 'unknown') },
    on: (event: string) => listeners.push(event),
  };
  return { ctx, logs, registered, listeners };
}

test('package.json main resolves to a loadable file exporting apply', async () => {
  assert.equal(pkg.main, 'lib/index.js');
  assert.ok(pkg.exports['.']!.default!.includes('lib/index.js'), `export map agrees with main: ${pkg.exports['.']!.default}`);
  const mainFile = resolve(join(here, '..', 'lib', 'index.js'));
  const half = await importHostHalf();
  assert.equal(typeof half.apply, 'function', `apply() exported from ${mainFile}`);
});

test('a host-style mount logs through the framework logger and registers nothing', async () => {
  const { apply } = await importHostHalf();
  const wired = makeCtx();
  apply(wired.ctx);
  assert.deepEqual(
    wired.logs,
    ['dsh-token-telemetry: host half loaded'],
    `proof-of-load line: ${wired.logs.join('|')}`,
  );
  assert.deepEqual(wired.registered, [], 'the host half is a presentation surface — no commands or tools');
  assert.deepEqual(wired.listeners, [], 'no event middleware either');
});

test('the host applies config and remounts without state: two mounts, two loads, zero side effects', async () => {
  const { apply } = await importHostHalf();
  const wired = makeCtx();
  apply(wired.ctx, { enabled: false } as never); // hosts pass config even though apply ignores it
  apply(wired.ctx);
  assert.equal(wired.logs.length, 2, `both mounts logged: ${wired.logs.join('|')}`);
  assert.deepEqual(wired.registered, []);
});

test('a broken host logger degrades to the console fallback instead of failing the mount', async () => {
  const { apply } = await importHostHalf();
  const original = console.log;
  const captured: string[] = [];
  console.log = (message: string) => captured.push(message);
  try {
    const broken = {
      // the host half touches ctx.logger?.info?.() without invoking the factory,
      // so only a throwing *getter* can engage the catch → console fallback
      get logger() {
        throw new Error('host logger unavailable');
      },
    };
    assert.doesNotThrow(() => apply(broken), 'a throwing logger never takes the plugin row down');
  } finally {
    console.log = original;
  }
  assert.ok(
    captured.some((line) => line.includes('[dsh-token-telemetry] host half loaded')),
    `console fallback seen: ${captured.join('|')}`,
  );
});

test('the browser half is wired through exports["./client"] on disk and the dsh.client manifest', () => {
  const clientFile = join(here, '..', pkg.exports['./client']!.default!);
  const client = readFileSync(clientFile, 'utf8');
  assert.ok(client.includes('dsh-token-telemetry'), `client module exists and is self-identified: ${clientFile}`);
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.equal(pkg.dsh?.client?.immediately, true, 'client half mounts immediately on session open');
  const typesFile = join(here, '..', pkg.types);
  assert.equal(readFileSync(typesFile, 'utf8').includes('export declare function apply'), true, `types entry (main sidebar) agrees: ${typesFile}`);
});
