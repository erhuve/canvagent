import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/shared/browser-annotations.js', import.meta.url), 'utf8');
type AnnotationState = { active: boolean; tool: string; color: string; count: number; canUndo: boolean; documentId: string };
type AnnotationApi = { command(input?: Record<string, unknown>): AnnotationState; dispose(): void };
type Handler = (event: Record<string, unknown>) => void;

function surface(local = false) {
  const listeners = new Map<string, Set<Handler>>();
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  const drawing: { strokes: number; rectangles: number; lastRect: number[]; move: number[] } = { strokes: 0, rectangles: 0, lastRect: [], move: [] };
  const context = {
    save() {}, restore() {}, setTransform() {}, clearRect() {}, beginPath() {}, lineTo() {},
    moveTo(...args: number[]) { drawing.move = args; },
    stroke() { drawing.strokes++; },
    strokeRect(...args: number[]) { drawing.rectangles++; drawing.lastRect = args; },
  };
  class Element {
    style = { values: new Map<string, string>(), setProperty(key: string, value: string) { this.values.set(key, value); } };
    children: Element[] = [];
    shadow?: Element;
    parent?: Element;
    width = 0;
    height = 0;
    rect = { left: local ? 120 : 0, top: local ? 80 : 0, width: 640, height: 480 };
    setAttribute() {}
    appendChild(child: Element) { this.children.push(child); child.parent = this; return child; }
    attachShadow() { this.shadow = new Element(); return this.shadow; }
    getContext() { return context; }
    getBoundingClientRect() { return this.rect; }
    setPointerCapture() {}
    releasePointerCapture() {}
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  }
  const body = new Element();
  const wrapper = new Element();
  let observerCallback: (() => void) | undefined;
  let observerDisconnected = false;
  const window = {
    innerWidth: 640, innerHeight: 480, devicePixelRatio: 2, scrollX: 0, scrollY: 0,
    location: { href: 'https://example.test/first' },
    crypto: { randomUUID: () => 'test-document' },
    history: { pushState(_state: unknown, _unused: string, url: string) { window.location.href = url; }, replaceState(_state: unknown, _unused: string, url: string) { window.location.href = url; } },
    addEventListener(name: string, handler: Handler) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(handler); },
    removeEventListener(name: string, handler: Handler) { listeners.get(name)?.delete(handler); },
    requestAnimationFrame(callback: () => void) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    __CANVAGENT_CREATE_BROWSER_ANNOTATIONS__: undefined as undefined | ((container?: Element) => AnnotationApi),
  };
  const originalPush = window.history.pushState;
  runInNewContext(source, { window, document: { body, documentElement: new Element(), createElement: () => new Element() }, ResizeObserver: class { constructor(callback: () => void) { observerCallback = callback; } observe() {} disconnect() { observerDisconnected = true; } } });
  assert.equal(body.children.length, 0, 'loading the shared factory does not create an overlay');
  const factory = window.__CANVAGENT_CREATE_BROWSER_ANNOTATIONS__!;
  const api = factory(local ? wrapper : undefined);
  const parent = local ? wrapper : body;
  const host = parent.children[0];
  const canvas = host.shadow!.children[0];
  function emit(name: string, values: Record<string, unknown> = {}) {
    let consumed = false;
    const event = { target: canvas, pointerId: 1, button: 0, clientX: 140, clientY: 100, composedPath: () => [canvas, host], preventDefault: () => { consumed = true; }, stopImmediatePropagation() {}, ...values };
    for (const handler of listeners.get(name) || []) handler(event);
    return consumed;
  }
  function flush() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); }
  function stroke() { emit('pointerdown'); emit('pointermove', { clientX: 200, clientY: 150 }); emit('pointerup', { clientX: 210, clientY: 160 }); }
  return { api, window, drawing, canvas, host, parent, wrapper, emit, flush, stroke, originalPush, resize: () => observerCallback?.(), observerDisconnected: () => observerDisconnected, listeners };
}

test('annotation mode draws tools and preserves page interaction after stopping', () => {
  const page = surface();
  assert.equal(page.emit('pointerdown'), false);
  assert.equal(page.api.command({ command: 'start', tool: 'pen', color: '#Aa0099' }).color, '#aa0099');
  assert.equal(page.emit('pointerdown'), true);
  page.emit('pointermove', { clientX: 180, clientY: 120 });
  page.emit('pointerup');
  assert.equal(page.api.command().count, 1);
  assert.ok(page.drawing.strokes > 0);
  assert.equal(page.api.command({ command: 'stop' }).count, 1);
  assert.equal(page.canvas.style.values.get('pointer-events'), 'none');
  assert.equal(page.emit('pointerdown'), false);
  page.api.command({ command: 'start', tool: 'rectangle' });
  page.stroke();
  assert.equal(page.api.command().count, 2);
  assert.deepEqual(page.drawing.lastRect, [140, 100, 70, 60]);
  assert.equal(page.api.command({ command: 'undo' }).count, 1);
  const cleared = page.api.command({ command: 'clear' });
  assert.equal(cleared.active, true);
  assert.equal(cleared.canUndo, false);
  assert.equal(cleared.count, 0);
  assert.throws(() => page.api.command({ command: 'start', color: 'red' }), /six-digit/);
  assert.throws(() => page.api.command({ tool: 'script' }), /tool/);
});

test('native document marks follow scrolling and reset across navigation', () => {
  const page = surface();
  page.api.command({ command: 'start' });
  page.stroke();
  page.window.scrollY = 50;
  page.emit('scroll'); page.flush();
  assert.deepEqual(page.drawing.move, [140, 50]);
  page.window.history.pushState({}, '', 'https://example.test/next');
  assert.equal(page.api.command().count, 0);
  assert.equal(page.api.command().active, false);
  page.api.command({ command: 'start' }); page.stroke();
  page.emit('pagehide');
  assert.equal(page.api.command().count, 0);
  assert.equal(page.api.command().active, false);
  page.api.dispose();
  assert.equal(page.window.history.pushState, page.originalPush);
  assert.equal(page.parent.children.length, 0);
  assert.ok([...page.listeners.values()].every(handlers => handlers.size === 0));
  assert.throws(() => page.api.command(), /closed/);
});

test('iframe wrapper marks resize without accessing the frame or changing app history', () => {
  const page = surface(true);
  assert.equal(page.window.history.pushState, page.originalPush);
  assert.equal(page.host.style.values.get('position'), 'absolute');
  page.api.command({ command: 'start', tool: 'highlight' });
  page.stroke();
  assert.deepEqual(page.drawing.move, [20, 20]);
  page.wrapper.rect.width = 320;
  page.wrapper.rect.height = 240;
  page.resize(); page.flush();
  assert.equal(page.canvas.width, 640);
  assert.equal(page.canvas.height, 480);
  assert.equal(page.api.command().count, 1);
  page.emit('keydown', { key: 'Escape' });
  assert.equal(page.api.command().active, false);
  assert.equal(page.api.command().count, 1);
  page.api.dispose();
  assert.equal(page.observerDisconnected(), true);
});
