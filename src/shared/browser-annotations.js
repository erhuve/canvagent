// Shared by the app's iframe surface and the native browser's isolated page.
// This script has no desktop bridge, network calls, or page-content capture.
(() => {
  if (window.__CANVAGENT_CREATE_BROWSER_ANNOTATIONS__?.version === 1) return;
  const TOOLS = new Set(['pen', 'highlight', 'rectangle']);
  const COMMANDS = new Set(['start', 'stop', 'settings', 'undo', 'clear', 'state']);
  const MAX_MARKS = 500;
  const MAX_POINTS = 100000;
  const MAX_STROKE_POINTS = 10000;

  function createAnnotations(container) {
    const local = !!container && container !== document.body && container !== document.documentElement;
    const parent = container || document.body || document.documentElement;
    if (!parent) throw new Error('The page is not ready for annotations.');
    const host = document.createElement('div');
    host.setAttribute('data-canvagent-browser-annotations', '');
    host.setAttribute('aria-hidden', 'true');
    const style = {
      all: 'initial', display: 'block', position: local ? 'absolute' : 'fixed',
      top: '0', left: '0', margin: '0', padding: '0', border: '0',
      opacity: '1', visibility: 'visible', transform: 'none',
      background: 'transparent', overflow: 'hidden', isolation: 'isolate',
      zIndex: '2147483647', pointerEvents: 'none', touchAction: 'none', userSelect: 'none',
    };
    for (const [key, value] of Object.entries(style)) host.style.setProperty(key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`), value, 'important');
    const shadow = host.attachShadow({ mode: 'open' });
    const canvas = document.createElement('canvas');
    canvas.setAttribute('data-canvagent-annotation-canvas', '');
    canvas.style.setProperty('display', 'block', 'important');
    canvas.style.setProperty('width', '100%', 'important');
    canvas.style.setProperty('height', '100%', 'important');
    canvas.style.setProperty('pointer-events', 'none', 'important');
    canvas.style.setProperty('touch-action', 'none', 'important');
    shadow.appendChild(canvas);
    parent.appendChild(host);
    const context = canvas.getContext('2d');
    if (!context) { host.remove(); throw new Error('Browser drawing is unavailable.'); }

    const documentId = window.crypto?.randomUUID?.() || `annotation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let active = false;
    let tool = 'pen';
    let color = '#e5484d';
    let marks = [];
    let current;
    let disposed = false;
    let width = 1;
    let height = 1;
    let scheduled = 0;
    let page = window.location.href;
    const listeners = [];
    const on = (target, event, handler, options) => {
      target.addEventListener(event, handler, options);
      listeners.push(() => target.removeEventListener(event, handler, options));
    };
    const origin = () => local ? { x: 0, y: 0 } : { x: window.scrollX || 0, y: window.scrollY || 0 };
    const status = () => ({ active, tool, color, count: marks.length, canUndo: marks.length > 0 || !!current, documentId });
    const consume = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const hit = event => event.target === canvas || event.target === host || event.composedPath?.().includes(host);
    const point = event => {
      const rect = host.getBoundingClientRect();
      const offset = origin();
      return { x: event.clientX - rect.left + offset.x, y: event.clientY - rect.top + offset.y };
    };
    function draw(mark) {
      const offset = origin();
      context.save();
      context.strokeStyle = mark.color;
      context.lineWidth = mark.tool === 'highlight' ? 18 : 3;
      context.globalAlpha = mark.tool === 'highlight' ? 0.3 : 1;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      const first = mark.points[0];
      if (mark.tool === 'rectangle') {
        const last = mark.points[mark.points.length - 1];
        context.strokeRect(Math.min(first.x, last.x) - offset.x, Math.min(first.y, last.y) - offset.y, Math.abs(last.x - first.x), Math.abs(last.y - first.y));
      } else {
        context.beginPath();
        context.moveTo(first.x - offset.x, first.y - offset.y);
        if (mark.points.length === 1) context.lineTo(first.x - offset.x + 0.01, first.y - offset.y);
        else for (let index = 1; index < mark.points.length; index++) context.lineTo(mark.points[index].x - offset.x, mark.points[index].y - offset.y);
        context.stroke();
      }
      context.restore();
    }
    function render() {
      if (disposed) return;
      context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
      context.clearRect(0, 0, width, height);
      for (const mark of marks) draw(mark);
      if (current) draw(current);
    }
    function resize() {
      if (disposed) return;
      const bounds = local ? parent.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
      width = Math.max(1, bounds.width); height = Math.max(1, bounds.height);
      host.style.setProperty('width', `${width}px`, 'important');
      host.style.setProperty('height', `${height}px`, 'important');
      const ratio = Math.min(Math.max(1, window.devicePixelRatio || 1), 3, Math.sqrt(16000000 / (width * height)));
      const pixelsWide = Math.max(1, Math.round(width * ratio));
      const pixelsHigh = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) { canvas.width = pixelsWide; canvas.height = pixelsHigh; }
      render();
    }
    function scheduleResize() {
      window.cancelAnimationFrame(scheduled);
      scheduled = window.requestAnimationFrame(resize);
    }
    function finish(commit) {
      if (!current) return;
      const completed = current;
      current = undefined;
      try { canvas.releasePointerCapture(completed.pointerId); } catch { /* Capture can end on navigation or blur. */ }
      if (commit) {
        marks.push(completed);
        let points = marks.reduce((total, mark) => total + mark.points.length, 0);
        while (marks.length > MAX_MARKS || points > MAX_POINTS) points -= marks.shift().points.length;
      }
      render();
    }
    function setActive(value) {
      if (!value) finish(true);
      active = value;
      canvas.style.setProperty('pointer-events', active ? 'auto' : 'none', 'important');
      canvas.style.setProperty('cursor', active ? 'crosshair' : 'default', 'important');
    }
    function clearPage() {
      finish(false); marks = []; setActive(false); page = window.location.href; render();
    }
    on(window, 'pointerdown', event => {
      if (!active || !hit(event) || event.button !== 0 || current) return;
      consume(event);
      current = { tool, color, pointerId: event.pointerId, points: [point(event)] };
      try { canvas.setPointerCapture(event.pointerId); } catch { /* Synthetic events need no native capture. */ }
      render();
    }, { capture: true, passive: false });
    on(window, 'pointermove', event => {
      if (!active || !current || current.pointerId !== event.pointerId) return;
      consume(event);
      const events = event.getCoalescedEvents?.() || [event];
      for (const sample of events.length ? events : [event]) {
        const next = point(sample);
        const previous = current.points[current.points.length - 1];
        if (current.tool === 'rectangle') current.points[1] = next;
        else if (current.points.length < MAX_STROKE_POINTS && Math.hypot(next.x - previous.x, next.y - previous.y) >= 0.5) current.points.push(next);
      }
      render();
    }, { capture: true, passive: false });
    on(window, 'pointerup', event => {
      if (!current || current.pointerId !== event.pointerId) return;
      consume(event);
      if (current.tool === 'rectangle') current.points[1] = point(event);
      finish(true);
    }, { capture: true, passive: false });
    on(window, 'pointercancel', event => {
      if (current?.pointerId === event.pointerId) { consume(event); finish(false); }
    }, { capture: true, passive: false });
    for (const event of ['click', 'dblclick', 'contextmenu']) on(window, event, event => { if (active && hit(event)) consume(event); }, { capture: true, passive: false });
    on(window, 'keydown', event => { if (active && event.key === 'Escape') { consume(event); setActive(false); } }, true);
    on(window, 'blur', () => finish(true));
    on(window, 'resize', scheduleResize);
    on(window, 'scroll', scheduleResize, true);
    if (window.visualViewport) on(window.visualViewport, 'resize', scheduleResize);
    on(window, 'pagehide', clearPage);
    on(window, 'pageshow', event => { if (event.persisted) clearPage(); });
    for (const event of ['popstate', 'hashchange']) on(window, event, () => { if (page !== window.location.href) clearPage(); });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleResize) : undefined;
    if (local) observer?.observe(parent);

    const historyOriginals = [];
    if (!local) for (const name of ['pushState', 'replaceState']) {
      const original = window.history[name];
      const wrapped = function (...args) {
        const result = Reflect.apply(original, this, args);
        if (page !== window.location.href) clearPage();
        return result;
      };
      try { window.history[name] = wrapped; historyOriginals.push([name, original, wrapped]); } catch { /* A page may protect its history methods. */ }
    }
    resize();
    const api = Object.freeze({
      command(input = {}) {
        if (disposed) throw new Error('The annotation surface was closed.');
        const command = input.command || 'state';
        if (!COMMANDS.has(command)) throw new Error('Unknown annotation command.');
        if (input.tool !== undefined && !TOOLS.has(input.tool)) throw new Error('Unknown annotation tool.');
        if (input.color !== undefined && (typeof input.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(input.color))) throw new Error('Choose a six-digit annotation color.');
        if (input.tool !== undefined) tool = input.tool;
        if (input.color !== undefined) color = input.color.toLowerCase();
        if (command === 'start') { resize(); setActive(true); }
        else if (command === 'stop') setActive(false);
        else if (command === 'undo') { if (current) finish(false); else marks.pop(); render(); }
        else if (command === 'clear') { finish(false); marks = []; render(); }
        return status();
      },
      dispose() {
        if (disposed) return;
        finish(false); active = false; disposed = true;
        window.cancelAnimationFrame(scheduled);
        observer?.disconnect();
        for (const remove of listeners) remove();
        for (const [name, original, wrapped] of historyOriginals) if (window.history[name] === wrapped) window.history[name] = original;
        host.remove(); marks = [];
      },
    });
    return api;
  }
  Object.defineProperty(createAnnotations, 'version', { value: 1 });
  Object.defineProperty(window, '__CANVAGENT_CREATE_BROWSER_ANNOTATIONS__', { value: createAnnotations, configurable: true });
})();
