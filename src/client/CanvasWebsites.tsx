import { useCallback, useEffect, useRef, useState } from 'react';
import { CaptureUpdateAction, restoreElements } from '@excalidraw/excalidraw';
import { generateKeyBetween } from 'fractional-indexing';
import { Icon } from './icons';
import type { SceneElement } from './types';
import './CanvasWebsites.css';

type Website = { id: string; url: string };

function websiteUrl(input: string) {
  const value = input.trim();
  if (!value) throw new Error('Enter a website address.');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `${/^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(value) ? 'http' : 'https'}://${value}`);
  } catch { throw new Error('Enter a valid http or https address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an http or https address without login details.');
  if (url.origin === location.origin) throw new Error('Enter your app’s development server address, rather than Canvagent’s own address.');
  return url.href;
}

export function validateCanvasWebsite(link: string) {
  try { return websiteUrl(link) === new URL(link).href; } catch { return false; }
}

function CanvasWebsite({ url, browsing, reload }: { url: string; browsing: boolean; reload: number }) {
  const [loading, setLoading] = useState(true);
  useEffect(() => setLoading(true), [url, reload]);
  return <div className="canvas-website" data-browsing={browsing}>
    {loading && <div className="canvas-website-loading"><span className="working-spinner" />Opening website…</div>}
    <iframe key={reload} title="Canvas website" src={url} onLoad={() => setLoading(false)}
      sandbox="allow-scripts allow-forms allow-same-origin allow-popups" referrerPolicy="no-referrer" />
  </div>;
}

/** Embed geometry and drawings belong to the native scene; input mode is local UI. */
export function useCanvasWebsites() {
  const editor = useRef<any>();
  const [websites, setWebsites] = useState<Website[]>([]);
  const [chosenId, setChosenId] = useState('');
  const [browsingId, setBrowsingId] = useState('');
  const [reloads, setReloads] = useState<Record<string, number>>({});
  const chosen = websites.find(website => website.id === chosenId) ?? websites[0];
  const browsing = !!chosen && browsingId === chosen.id;

  const bindEditor = useCallback((api: any) => { editor.current = api; }, []);
  const onChange = useCallback((elements: readonly SceneElement[], appState: any) => {
    const next = elements.filter(element => !element.isDeleted && element.type === 'embeddable' && validateCanvasWebsite(element.link))
      .map(element => ({ id: element.id, url: element.link as string }));
    setWebsites(previous => previous.length === next.length && previous.every((website, index) => website.id === next[index].id && website.url === next[index].url) ? previous : next);
    const selected = next.find(website => appState.selectedElementIds[website.id]);
    if (selected) setChosenId(selected.id);
    setBrowsingId(previous => next.some(website => website.id === previous) && (!selected || selected.id === previous) ? previous : '');
  }, []);

  const draw = useCallback(() => {
    setBrowsingId('');
    editor.current?.updateScene({ appState: { activeEmbeddable: null }, captureUpdate: CaptureUpdateAction.NEVER });
    editor.current?.setActiveTool({ type: 'freedraw' });
  }, []);

  const browse = useCallback(() => {
    if (!chosen) return;
    editor.current?.setActiveTool({ type: 'selection' });
    editor.current?.updateScene({ appState: { activeEmbeddable: null, selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
    setBrowsingId(chosen.id);
  }, [chosen]);

  const choose = (id: string) => { setChosenId(id); setBrowsingId(''); };
  const locate = () => {
    const element = editor.current?.getSceneElements().find((element: SceneElement) => element.id === chosen?.id);
    if (!element) return;
    setBrowsingId('');
    editor.current.setActiveTool({ type: 'selection' });
    editor.current.updateScene({ appState: { activeEmbeddable: null, selectedElementIds: { [element.id]: true } }, captureUpdate: CaptureUpdateAction.NEVER });
    editor.current.scrollToContent(element, { fitToContent: true, maxZoom: 1 });
  };

  const add = (input: string) => {
    const url = websiteUrl(input);
    const api = editor.current;
    if (!api) throw new Error('The canvas is still opening. Try again in a moment.');
    const state = api.getAppState();
    const width = 960, height = 640;
    const x = state.width / (2 * state.zoom.value) - state.scrollX - width / 2;
    const y = state.height / (2 * state.zoom.value) - state.scrollY - height / 2;
    const existing: SceneElement[] = api.getSceneElementsIncludingDeleted();
    const [element] = restoreElements([{ id: crypto.randomUUID(), type: 'embeddable', x, y, width, height, link: url,
      strokeColor: 'transparent', backgroundColor: 'transparent', roughness: 0, roundness: null,
      customData: { canvagent: { kind: 'browser', version: 1 } } } as any], null);
    const website = { ...element, strokeWidth: 1, index: generateKeyBetween(null, existing[0]?.index ?? null) };
    // Keep embeds underneath drawings in both the native scene and the DOM.
    api.updateScene({ elements: [website, ...existing],
      appState: { activeEmbeddable: null, selectedElementIds: {}, viewBackgroundColor: 'transparent' }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setChosenId(element.id);
    setBrowsingId('');
    api.scrollToContent(website, { fitToContent: true, maxZoom: 1 });
    api.setActiveTool({ type: 'freedraw' });
  };

  // Excalidraw caches validation by ID. A remote edit can change a cached
  // element's link, so check the current address at the iframe boundary too.
  const renderEmbeddable = useCallback((element: any) => validateCanvasWebsite(element.link)
    ? <CanvasWebsite url={element.link} browsing={browsingId === element.id} reload={reloads[element.id] ?? 0} />
    : <div className="canvas-website canvas-website-invalid">This website address cannot be embedded.</div>, [browsingId, reloads]);
  const reload = () => { if (chosen) setReloads(previous => ({ ...previous, [chosen.id]: (previous[chosen.id] ?? 0) + 1 })); };

  return { bindEditor, onChange, renderEmbeddable, websites, chosen, browsing, add, choose, draw, browse, locate, reload };
}

export function CanvasWebsiteTools({ controller, ready }: { controller: ReturnType<typeof useCanvasWebsites>; ready: boolean }) {
  const { websites, chosen, browsing } = controller;
  const dialog = useRef<HTMLDialogElement>(null);
  const [address, setAddress] = useState('http://localhost:3000');
  const [error, setError] = useState('');

  return <>
    <div className="canvas-website-tools" aria-label="Canvas website controls">
      <button type="button" className="website-add" disabled={!ready} onClick={() => { setError(''); dialog.current?.showModal(); }}><Icon name="plus" size={14} /><span>Add website</span></button>
      {chosen ? <>
        {websites.length > 1 ? <select aria-label="Website frame" value={chosen.id} onChange={event => controller.choose(event.target.value)}>{websites.map((website, index) => <option key={website.id} value={website.id}>{index + 1}. {website.url}</option>)}</select>
          : <span className="canvas-website-address" title={chosen.url}><Icon name="globe" size={13} />{chosen.url}</span>}
        <div className="website-input-mode" role="group" aria-label="Website input mode">
          <button type="button" aria-label="Browse website" aria-pressed={browsing} onClick={controller.browse}><Icon name="select" size={13} />Browse</button>
          <button type="button" aria-label="Draw on canvas" aria-pressed={!browsing} onClick={controller.draw}><Icon name="compose" size={13} />Draw</button>
        </div>
        <button type="button" className="website-icon-button" aria-label="Select website frame" title="Select, move or resize this website" onClick={controller.locate}><Icon name="board" size={14} /></button>
        <button type="button" className="website-icon-button" aria-label="Reload website" onClick={controller.reload}><Icon name="reconnect" size={14} /></button>
        <a className="website-icon-button" href={chosen.url} target="_blank" rel="noreferrer" aria-label="Open canvas website externally"><Icon name="external" size={14} /></a>
      </> : <span className="canvas-website-intro">Put a live app preview on your canvas and draw over it.</span>}
    </div>
    {chosen && <p className="canvas-website-hint">{browsing ? 'Clicks and scrolling go to the website. Choose Draw to sketch over it.' : 'Drawings stay on the canvas as the page changes. Choose Browse to use the website.'} <span title="Agent captures and image exports contain the frame placeholder and your drawings, without the live webpage pixels.">Page pixels aren’t included in agent captures.</span></p>}
    <dialog ref={dialog} className="project-dialog website-dialog" aria-labelledby="website-dialog-title">
      <form onSubmit={event => {
        event.preventDefault();
        try { controller.add(address); dialog.current?.close(); setError(''); } catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)); }
      }}>
        <div className="project-dialog-heading"><Icon name="globe" size={21} /><h2 id="website-dialog-title">Add website to canvas</h2><button type="button" aria-label="Close website dialog" onClick={() => dialog.current?.close()}><Icon name="close" size={18} /></button></div>
        <p>Open a live localhost preview or a website that allows embedding. Draw over it with your usual canvas tools.</p>
        <label htmlFor="canvas-website-address">Website address</label>
        <input id="canvas-website-address" value={address} onChange={event => setAddress(event.target.value)} autoFocus autoComplete="off" spellCheck={false} maxLength={4096} required />
        <p className="website-dialog-note">Some sites block embedding. Use the Browser panel for those sites. Frames save their URL and drawings; the page’s current state isn’t part of the saved board.</p>
        {error && <p className="project-dialog-error" role="alert">{error}</p>}
        <div className="project-dialog-actions"><button type="button" onClick={() => dialog.current?.close()}>Cancel</button><button type="submit" className="button-dark">Add to canvas</button></div>
      </form>
    </dialog>
  </>;
}
