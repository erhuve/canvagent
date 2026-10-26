import { useCallback, useRef, useState } from "react";
import { CaptureUpdateAction, exportToCanvas, getCommonBounds, serializeAsJSON } from "@excalidraw/excalidraw";
import { api, ApiError, errorMessage } from "./api";
import type { Board, MutationResult, PendingEdit, Region, SceneElement } from "./types";

type SaveStatus = "saved" | "pending" | "saving" | "conflict" | "error";
type MutationInfo = { id: string; actor: string };

function equivalent(left: SceneElement | undefined, right: SceneElement | undefined) {
  if (!left || left.isDeleted) return !right || !!right.isDeleted;
  if (!right || right.isDeleted) return false;
  // Excalidraw restores empty bindings as []; that normalization is not a user edit.
  const semantic = (element: SceneElement) => JSON.stringify({ ...element, boundElements: element.boundElements ?? [] }, (key, value) => ["version", "versionNonce", "updated"].includes(key) ? undefined : value);
  return semantic(left) === semantic(right);
}

function mergeElements(board: Board, pending: Map<string, PendingEdit>): SceneElement[] {
  const result = new Map(board.elements.map(element => [element.id, element]));
  for (const [id, edit] of pending) result.set(id, edit.element);
  return [...result.values()];
}

export function useBoard(notify: (message: string) => void) {
  const [board, setBoard] = useState<Board>();
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [conflictIds, setConflictIds] = useState<string[]>([]);
  const [agentMutation, setAgentMutation] = useState<string>();
  const [elementCount, setElementCount] = useState(0);
  const canonical = useRef<Board>();
  const pending = useRef(new Map<string, PendingEdit>());
  const inFlight = useRef<Map<string, PendingEdit>>();
  const saving = useRef<Promise<boolean>>();
  const editor = useRef<any>();
  const elements = useRef<SceneElement[]>([]);
  const files = useRef<Record<string, any>>({});
  const interaction = useRef<any>({});
  const uploadedFiles = useRef(new Set<string>());
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const flushRef = useRef<() => Promise<boolean>>(async () => true);
  const conflicted = useRef(false);
  const pointerActive = useRef(false);
  const clearHistoryAfterGesture = useRef(false);

  const renderMerged = useCallback(() => {
    if (!canonical.current || pointerActive.current) return;
    const rendered = structuredClone(mergeElements(canonical.current, pending.current));
    // Excalidraw mutates native elements in place; keep a separate comparison snapshot.
    elements.current = structuredClone(rendered);
    setElementCount(elements.current.filter(element => !element.isDeleted).length);
    files.current = { ...canonical.current.files, ...files.current };
    editor.current?.addFiles(Object.values(files.current));
    editor.current?.updateScene({ elements: rendered, captureUpdate: CaptureUpdateAction.NEVER });
  }, []);

  const receiveBoard = useCallback((incoming: Board, mutation?: MutationInfo) => {
    const previous = canonical.current;
    if (previous && incoming.revision < previous.revision) return;
    for (const id of Object.keys(incoming.files || {})) uploadedFiles.current.add(id);
    const incomingElements = new Map(incoming.elements.map(element => [element.id, element]));
    for (const [id, edit] of pending.current) {
      const accepted = incomingElements.get(id);
      if (equivalent(edit.element, accepted)) {
        pending.current.delete(id);
      } else if (inFlight.current?.has(id) && equivalent(inFlight.current.get(id)!.element, accepted)) {
        edit.expectedRevision = incoming.metadata[id]?.revision;
      }
    }
    canonical.current = structuredClone({ ...incoming, files: incoming.files || {}, metadata: incoming.metadata || {} });
    files.current = { ...incoming.files, ...files.current };
    setBoard(canonical.current);
    if (Object.hasOwn(incoming, "lastAgentMutation")) setAgentMutation(incoming.lastAgentMutation ?? undefined);
    else if (mutation?.actor === "agent") setAgentMutation(mutation.id);
    else if (mutation?.actor === "undo") setAgentMutation(undefined);
    if (previous && incoming.revision > previous.revision && mutation && mutation.actor !== "human") {
      // Native history has no revision guards. The shared undo endpoint does.
      if (pointerActive.current) clearHistoryAfterGesture.current = true;
      else editor.current?.history.clear();
    }
    renderMerged();
    if (!pending.current.size && !saving.current) {
      conflicted.current = false;
      setConflictIds([]);
      setSaveStatus("saved");
      setSaveError("");
    }
  }, [renderMerged]);

  const flush = useCallback(async (): Promise<boolean> => {
    clearTimeout(saveTimer.current);
    if (saving.current) {
      if (!await saving.current) return false;
      return flushRef.current();
    }
    if (conflicted.current) return false;
    const current = canonical.current;
    if (!current || !pending.current.size) { setSaveStatus("saved"); setSaveError(""); return true; }
    const edits = new Map([...pending.current].map(([id, edit]) => [id, { ...edit }]));
    inFlight.current = edits;
    setSaveStatus("saving");
    setSaveError("");
    const task = (async () => {
      try {
        const missingFiles = Object.fromEntries(Object.entries(files.current).filter(([id]) => !uploadedFiles.current.has(id)));
        if (Object.keys(missingFiles).length) {
          await api("/api/board/files", { files: missingFiles });
          Object.keys(missingFiles).forEach(id => uploadedFiles.current.add(id));
        }
        const operations = [...edits].map(([elementId, edit]) => {
          if (edit.element.isDeleted) return { kind: "delete", elementId, expectedRevision: edit.expectedRevision };
          if (edit.expectedRevision === undefined) return { kind: "create", elementId, element: edit.element };
          if (canonical.current?.elements.find(element => element.id === elementId)?.isDeleted) return { kind: "restore", elementId, expectedRevision: edit.expectedRevision, patch: { ...edit.element, isDeleted: false } };
          return { kind: "update", elementId, expectedRevision: edit.expectedRevision, patch: edit.element };
        });
        const result = await api<MutationResult>("/api/board/mutate", { requestId: crypto.randomUUID(), observedBoardRevision: current.revision, operations });
        if (!result.ok) throw new ApiError(result.message || "Some objects changed while you were drawing.", 409, result);
        if (result.board) receiveBoard(result.board);
        else if (canonical.current && result.boardRevision !== undefined && result.boardRevision >= canonical.current.revision) {
          const next = new Map(canonical.current.elements.map(element => [element.id, element]));
          for (const element of result.changedElements || []) next.set(element.id, element);
          receiveBoard({ ...canonical.current, revision: result.boardRevision, elements: [...next.values()], metadata: { ...canonical.current.metadata, ...result.metadata } });
        }
        setSaveStatus(pending.current.size ? "pending" : "saved");
        return true;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 409 || error.payload?.conflicts?.length)) {
          const ids = (error.payload?.conflicts || []).map((conflict: any) => conflict.elementId).filter(Boolean);
          setConflictIds(ids.length ? ids : [...edits.keys()]);
          conflicted.current = true;
          setSaveStatus("conflict");
          setSaveError("The saved version changed. Your drawing is preserved until you choose which edits to keep.");
          try { const state = await api<any>("/api/state"); receiveBoard(state.board); } catch { /* Keep local edits when offline. */ }
        } else {
          setSaveStatus("error");
          setSaveError(errorMessage(error));
        }
        return false;
      } finally {
        inFlight.current = undefined;
        saving.current = undefined;
      }
    })();
    saving.current = task;
    const success = await task;
    if (success && pending.current.size) return flushRef.current();
    return success;
  }, [receiveBoard]);
  flushRef.current = flush;

  const onChange = useCallback((next: readonly any[], appState: any, nextFiles: Record<string, any>) => {
    interaction.current = appState;
    const ids = Object.keys(appState.selectedElementIds || {}).filter(id => appState.selectedElementIds[id]);
    setSelectedIds(previous => previous.join("|") === ids.join("|") ? previous : ids);
    if (!canonical.current) return;
    files.current = { ...files.current, ...nextFiles };
    const previous = new Map(elements.current.map(element => [element.id, element]));
    elements.current = structuredClone([...next]);
    setElementCount(next.filter(element => !element.isDeleted).length);
    const saved = new Map(canonical.current.elements.map(element => [element.id, element]));
    const nextIds = new Set(next.map(element => element.id));
    const updated = new Map(pending.current);
    for (const element of next) {
      if (equivalent(element, previous.get(element.id))) continue;
      if (!equivalent(element, saved.get(element.id))) updated.set(element.id, { element: structuredClone(element), expectedRevision: pending.current.get(element.id)?.expectedRevision ?? canonical.current.metadata[element.id]?.revision });
      else updated.delete(element.id);
    }
    for (const element of previous.values()) {
      if (!element.isDeleted && !nextIds.has(element.id)) {
        if (!saved.has(element.id)) updated.delete(element.id);
        else updated.set(element.id, { element: { ...element, isDeleted: true }, expectedRevision: pending.current.get(element.id)?.expectedRevision ?? canonical.current.metadata[element.id]?.revision });
      }
    }
    const changed = updated.size !== pending.current.size || [...updated].some(([id, edit]) => pending.current.get(id) !== edit);
    pending.current = updated;
    if (!conflicted.current && changed) {
      if (updated.size) {
        setSaveStatus(saving.current ? "saving" : "pending");
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => void flushRef.current(), 650);
      } else if (!saving.current) setSaveStatus("saved");
    }
  }, []);

  const bindEditor = useCallback((api: any) => { editor.current = api; renderMerged(); }, [renderMerged]);
  const onPointerDown = useCallback(() => { pointerActive.current = true; }, []);
  const onPointerUp = useCallback(() => {
    pointerActive.current = false;
    // Let Excalidraw publish the completed gesture before reconciling remote edits.
    setTimeout(() => {
      if (clearHistoryAfterGesture.current) { editor.current?.history.clear(); clearHistoryAfterGesture.current = false; }
      renderMerged();
    }, 0);
  }, [renderMerged]);

  const resolveConflict = useCallback((keepLocal: boolean) => {
    if (!canonical.current) return;
    for (const id of conflictIds) {
      if (!keepLocal) pending.current.delete(id);
      else if (pending.current.has(id)) pending.current.get(id)!.expectedRevision = canonical.current.metadata[id]?.revision;
    }
    conflicted.current = false;
    setConflictIds([]);
    setSaveError("");
    renderMerged();
    setSaveStatus(pending.current.size ? "pending" : "saved");
    if (pending.current.size) void flushRef.current();
  }, [conflictIds, renderMerged]);

  const undoAgent = useCallback(async () => {
    if (!agentMutation || !await flushRef.current()) return;
    try {
      const result = await api<MutationResult>("/api/board/undo", { mutationId: agentMutation, requestId: crypto.randomUUID() });
      if (!result.ok) throw new Error("Those objects have changed since the agent edited them. Undo would overwrite newer work.");
      setAgentMutation(undefined);
      if (result.board) receiveBoard(result.board, { id: result.mutationId!, actor: "undo" });
      notify("Agent edit undone.");
    } catch (error) { notify(errorMessage(error)); }
  }, [agentMutation, notify, receiveBoard]);

  const exportBoard = useCallback(() => {
    const data = serializeAsJSON(elements.current as any, interaction.current, files.current, "local");
    const url = URL.createObjectURL(new Blob([data], { type: "application/vnd.excalidraw+json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `canvagent-${new Date().toISOString().slice(0, 10)}.excalidraw`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const capture = useCallback(async ({ id, board: snapshot, region }: { id: string; board: Board; region?: Region }) => {
    try {
      await document.fonts.ready;
      const visible = snapshot.elements.filter(element => !element.isDeleted);
      const [sceneX1, sceneY1, sceneX2, sceneY2] = visible.length ? getCommonBounds(visible as any) : [0, 0, 800, 500];
      const bounds = region || { x: sceneX1 - 24, y: sceneY1 - 24, width: Math.max(64, sceneX2 - sceneX1 + 48), height: Math.max(64, sceneY2 - sceneY1 + 48) };
      if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw new Error("The requested capture region is invalid.");
      const byId = new Map(visible.map(element => [element.id, element]));
      const included = new Set<string>();
      for (const element of visible) {
        const [left, top, right, bottom] = getCommonBounds([element] as any, byId as any);
        const margin = Math.max(8, (element.strokeWidth || 0) * 2);
        if (right + margin >= bounds.x && left - margin <= bounds.x + bounds.width && bottom + margin >= bounds.y && top - margin <= bounds.y + bounds.height) included.add(element.id);
      }
      // Keep native parent frames so their children retain the editor's clipping.
      for (const id of [...included]) {
        let parent = byId.get(id)?.frameId;
        const visited = new Set<string>();
        while (parent && byId.has(parent) && !visited.has(parent)) {
          visited.add(parent);
          included.add(parent);
          parent = byId.get(parent)?.frameId;
        }
      }
      const relevant = visible.filter(element => included.has(element.id));
      const frames = new Set(relevant.filter(element => element.type === "frame" || element.type === "magicframe").map(element => element.id));
      const roots = relevant.filter(element => frames.has(element.id) || !element.frameId || !frames.has(element.frameId));
      const [rootX, rootY] = roots.length ? getCommonBounds(roots as any) : [0, 0];
      const padding = 8;
      let sourceScale = 1;
      const source = relevant.length ? await exportToCanvas({
        elements: relevant as any,
        files: snapshot.files,
        appState: { exportBackground: true, viewBackgroundColor: "#ffffff", frameRendering: { enabled: true, clip: true, outline: true, name: false } },
        exportPadding: padding,
        getDimensions: (width: number, height: number) => {
          sourceScale = Math.min(1, 4096 / Math.max(1, width, height));
          return { width: Math.max(1, Math.ceil(width * sourceScale)), height: Math.max(1, Math.ceil(height * sourceScale)), scale: sourceScale };
        },
      }) : null;
      const scale = Math.min(1, 2048 / Math.max(bounds.width, bounds.height));
      const output = document.createElement("canvas");
      output.width = Math.max(1, Math.ceil(bounds.width * scale));
      output.height = Math.max(1, Math.ceil(bounds.height * scale));
      const context = output.getContext("2d")!;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, output.width, output.height);
      if (source) context.drawImage(source, (rootX - padding - bounds.x) * scale, (rootY - padding - bounds.y) * scale, source.width * scale / sourceScale, source.height * scale / sourceScale);
      await api("/api/capture-result", { id, dataURL: output.toDataURL("image/png"), revision: snapshot.revision, bounds });
    } catch (error) {
      await api("/api/capture-result", { id, revision: snapshot.revision, error: errorMessage(error) }).catch(() => undefined);
    }
  }, []);

  const selectElements = useCallback((ids: string[]) => {
    editor.current?.updateScene({ appState: { selectedElementIds: Object.fromEntries(ids.map(id => [id, true])) }, captureUpdate: CaptureUpdateAction.NEVER });
    const selected = elements.current.filter(element => ids.includes(element.id) && !element.isDeleted);
    if (selected.length) editor.current?.scrollToContent(selected, { fitToContent: true, animate: true, maxZoom: 1 });
  }, []);

  return { board, saveStatus, saveError, selectedIds, conflictIds, agentMutation, elementCount, onChange, onPointerDown, onPointerUp, bindEditor, receiveBoard, flush, resolveConflict, undoAgent, exportBoard, capture, selectElements };
}
