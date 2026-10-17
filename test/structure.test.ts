/**
 * Structure and contract tests for the prebuilt token-telemetry artifacts.
 * The plugin ships hand-written browser code (lib/client.js) and a host stub
 * (lib/index.js) with no source-of-truth TS build, so these tests audit the
 * load paths instead: client.js must execute inside a ModuleLoader sandbox
 * and export apply/inject, index.js must mount against a stub ctx, and the
 * package.json dsh.client manifest must agree with the module's inject list.
 * @module test/structure
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = join(fileURLToPath(import.meta.url), '..');
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

function executeClientModule(): { exports: { apply: unknown; inject: string[] }; logs: string[] } {
  const logs: string[] = [];
  let loaded: { factory: (require: (id: string) => unknown) => { apply: unknown; inject: string[] } } | null = null;
  const sandbox = {
    window: {
      __ModuleLoader__: { load(module: never) { loaded = module; } },
      devicePixelRatio: 1,
    },
    console: { log: (message: string) => logs.push(message), warn: (message: string) => logs.push(message) },
    require: (id: string) => {
      if (id === 'react') {
        return {
          createElement: (type: unknown,props: unknown, ...children: unknown[]) => ({ type, props, children }),
          useRef: (value: unknown) => ({ current: value }),
          useState: (initial: unknown) => [initial, () => {}],
          useEffect: () => {},
          useMemo: (factory: () => unknown) => factory(),
        };
      }
      throw new Error(`unexpected require: ${id}`);
    },
  };
  const code = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
  vm.runInNewContext(code, sandbox, { filename: 'client.js' });
  assert.ok(loaded, 'window.__ModuleLoader__.load called');
  assert.equal((loaded as { id: string }).id, 'dsh-token-telemetry', 'loader id');
  const exports = (loaded as { factory: (require: (id: string) => unknown) => { apply: unknown; inject: string[] } }).factory(sandbox.require);
  return { exports, logs };
}

test('lib/client.js executes inside the loader and exports the mounting surface', () => {
  const { exports } = executeClientModule();
  assert.equal(typeof exports.apply, 'function', 'apply export');
  assert.deepEqual([...exports.inject], ['slots', 'sessions'], 'inject list drives the manifest');
});

test('the client apply path registers both slot surfaces', () => {
  const { exports } = executeClientModule();
  const registered: string[] = [];
  const ctx = {
    slots: {
      inject(name: string, task: () => void) {
        registered.push(name);
        task();
      },
      register(meta: unknown, component: unknown) {
        assert.ok(component, 'component passed to register');
        return meta;
      },
    },
    sessions: { binding: () => null },
  };
  (exports as { apply: (c: unknown) => void }).apply(ctx);
  assert.deepEqual(registered, ['conversation.view', 'conversation.chat.turnTail'], 'aggregate view + turn tail mounted');
});

test('the client never breaks when slots are absent (warn-only mount)', () => {
  const { exports, logs } = executeClientModule();
  (exports as { apply: (c: unknown) => void }).apply({ sessions: {} });
  assert.ok(logs.some((line) => line.includes('ctx.slots unavailable')), 'missing slots logs a warn and never throws');
});

test('lib/index.js host half mounts and logs through the framework logger', async () => {
  const { apply } = await import('../lib/index.js');
  const calls: string[] = [];
  apply({ logger: { info: (message: string) => calls.push(message) } });
  assert.deepEqual(calls, ['dsh-token-telemetry: host half loaded']);
  apply({}); // logger missing: must not throw
});

test('package.json dsh.client manifest agrees with the browser-half contract', () => {
  const dsh = pkg.dsh as { client?: Record<string, unknown> };
  assert.ok(dsh.client, 'dsh.client manifest present');
  assert.equal(dsh.client.platform, 'web');
  assert.equal(dsh.client.immediately, true);
  assert.deepEqual(dsh.client.inject, ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-session'], 'manifest inject lists required host packages');
  assert.ok(pkg.exports['./client'], './client export exists for the loader discovery path');
});
