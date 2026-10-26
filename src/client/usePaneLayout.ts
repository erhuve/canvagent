import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { api, apiPath, errorMessage } from "./api";

type Preferences = { sidebarWidth: number; chatRatio: number };
const defaults: Preferences = { sidebarWidth: 240, chatRatio: .85 / 2.35 };
const dividerWidth = 6;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function usePaneLayout(workspace: string | undefined, onError: (message: string) => void) {
  const shellRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLElement>(null);
  const [preferences, setPreferences] = useState(defaults);
  const current = useRef(preferences);
  const revision = useRef(0);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const [dimensions, setDimensions] = useState({ shell: window.innerWidth, split: 0 });
  const [resizing, setResizing] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const pendingSave = useRef(false);
  const saveQueue = useRef(Promise.resolve());

  useLayoutEffect(() => {
    const measure = () => setDimensions({ shell: shellRef.current?.clientWidth ?? window.innerWidth, split: splitRef.current?.clientWidth ?? 0 });
    const observer = new ResizeObserver(measure);
    if (shellRef.current) observer.observe(shellRef.current);
    if (splitRef.current) observer.observe(splitRef.current);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!workspace) return;
    const controller = new AbortController();
    const initialRevision = revision.current;
    void api<Preferences>("/api/layout/settings", undefined, { signal: controller.signal }).then(saved => {
      if (controller.signal.aborted || revision.current !== initialRevision) return;
      if (!Number.isFinite(saved.sidebarWidth) || !Number.isFinite(saved.chatRatio)) return;
      current.current = { sidebarWidth: clamp(saved.sidebarWidth, 180, 420), chatRatio: clamp(saved.chatRatio, .1, .9) };
      setPreferences(current.current);
    }).catch(error => {
      if (!controller.signal.aborted) errorHandler.current(`Could not load pane sizes: ${errorMessage(error)}`);
    });
    return () => controller.abort();
  }, [workspace]);

  const save = useCallback(() => {
    clearTimeout(saveTimer.current);
    if (!pendingSave.current) return;
    pendingSave.current = false;
    const saved = { ...current.current };
    // Keep the final drag update alive if project navigation follows immediately.
    saveQueue.current = saveQueue.current.catch(() => {}).then(async () => {
      const response = await fetch(apiPath("/api/layout/settings"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(saved), keepalive: true,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Request failed (${response.status})`);
      }
    }).catch(error => errorHandler.current(`Could not save pane sizes: ${errorMessage(error)}`));
  }, []);
  useEffect(() => {
    window.addEventListener("pagehide", save);
    return () => { window.removeEventListener("pagehide", save); save(); };
  }, [save]);

  const update = useCallback((change: Partial<Preferences>) => {
    current.current = { ...current.current, ...change };
    revision.current += 1;
    pendingSave.current = true;
    setPreferences(current.current);
  }, []);
  const commit = useCallback((immediate = false) => {
    clearTimeout(saveTimer.current);
    if (immediate) save();
    else saveTimer.current = setTimeout(save, 300);
  }, [save]);
  const dragging = useCallback((active: boolean) => {
    if (active) clearTimeout(saveTimer.current);
    setResizing(active);
    window.dispatchEvent(new CustomEvent("canvagent:layout-resize", { detail: { active } }));
  }, []);

  const sidebarMin = 180;
  const sidebarMax = Math.min(420, Math.max(sidebarMin, dimensions.shell - 640 - dividerWidth * 2));
  const sidebarWidth = clamp(preferences.sidebarWidth, sidebarMin, sidebarMax);
  const estimatedSplit = dimensions.shell - (dimensions.shell > 1200 ? sidebarWidth + dividerWidth : 0);
  const available = Math.max(1, (dimensions.split || estimatedSplit) - dividerWidth);
  const chatMin = Math.min(320, available / 2);
  const chatMax = Math.max(chatMin, available - 320);
  const chatWidth = clamp(available * preferences.chatRatio, chatMin, chatMax);
  const sidebar = {
    value: sidebarWidth, min: sidebarMin, max: sidebarMax,
    onChange: (value: number) => update({ sidebarWidth: clamp(value, 180, 420) }),
    onReset: () => { update({ sidebarWidth: defaults.sidebarWidth }); commit(true); },
  };
  const chat = {
    value: chatWidth, min: chatMin, max: chatMax,
    onChange: (value: number) => update({ chatRatio: clamp(value / available, .1, .9) }),
    onReset: () => { update({ chatRatio: defaults.chatRatio }); commit(true); },
  };
  const style = { "--sidebar-width": `${sidebarWidth}px`, "--chat-width": `${chatWidth}px` } as CSSProperties;
  return { shellRef, splitRef, style, resizing, sidebar, chat, commit, dragging };
}
