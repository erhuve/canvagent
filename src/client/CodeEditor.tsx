import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { monaco } from './monaco';
import { initVimMode } from 'monaco-vim';
import { registerEditorComments } from './editorComments';

export type CodeEditorHandle = {
  focus(): void;
  find(): void;
  replace(): void;
  goToLine(line: number, column?: number): void;
  commandPalette(): void;
  settleEdits(): Promise<void>;
  getSelection(): { startLine: number; endLine: number } | undefined;
};

export type CodeEditorProps = {
  path: string;
  projectKey: string;
  content: string;
  readOnly: boolean;
  vimEnabled: boolean;
  openPaths: string[];
  onChange(content: string): void;
  onSave(): void;
  onError(message: string): void;
  onCursorChange(position: { line: number; column: number }): void;
  onSelectionChange?(selection: { startLine: number; endLine: number } | undefined): void;
  onAttachSelection?(selection: { startLine: number; endLine: number } | undefined): void;
  onReady?(): void;
};

type OpenModel = { projectKey: string; path: string; model: monaco.editor.ITextModel; viewState: monaco.editor.ICodeEditorViewState | null };

export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const vimStatus = useRef<HTMLDivElement>(null);
  const vimAdapter = useRef<ReturnType<typeof initVimMode>>();
  const editor = useRef<monaco.editor.IStandaloneCodeEditor>();
  const comments = useRef<ReturnType<typeof registerEditorComments>>();
  const models = useRef(new Map<string, OpenModel>());
  const activeKey = useRef<string>();
  const applying = useRef(false);
  const latest = useRef(props);
  latest.current = props;

  const action = (id: string) => {
    editor.current?.focus();
    void editor.current?.getAction(id)?.run();
  };
  const selectedLines = () => {
    const selection = editor.current?.getSelection();
    if (!selection || selection.isEmpty()) return undefined;
    // Selecting to column 1 of the next line includes only the preceding lines.
    return { startLine: selection.startLineNumber, endLine: Math.max(selection.startLineNumber, selection.endLineNumber - (selection.endColumn === 1 ? 1 : 0)) };
  };
  useImperativeHandle(ref, () => ({
    focus: () => editor.current?.focus(),
    find: () => action('actions.find'),
    replace: () => action('editor.action.startFindReplaceAction'),
    commandPalette: () => action('editor.action.quickCommand'),
    settleEdits: () => comments.current?.whenIdle() ?? Promise.resolve(),
    getSelection: selectedLines,
    goToLine: (line, column = 1) => {
      const instance = editor.current;
      const model = instance?.getModel();
      if (!instance || !model) return;
      const position = model.validatePosition({ lineNumber: Math.max(1, line), column: Math.max(1, column) });
      instance.setPosition(position);
      instance.revealPositionInCenter(position);
      instance.focus();
    },
  }));

  useEffect(() => {
    if (!container.current) return;
    const instance = monaco.editor.create(container.current, {
      model: null, theme: 'canvagent-light', automaticLayout: true,
      ariaLabel: 'File contents', editContext: false,
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12, lineHeight: 21, minimap: { enabled: false },
      lineNumbers: 'on', lineNumbersMinChars: 3, glyphMargin: false,
      scrollBeyondLastLine: false, smoothScrolling: true, padding: { top: 14, bottom: 14 },
      tabSize: 2, insertSpaces: true, detectIndentation: true, renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true }, guides: { indentation: true, bracketPairs: true },
      stickyScroll: { enabled: false }, quickSuggestions: true, suggestOnTriggerCharacters: true,
      parameterHints: { enabled: true }, formatOnPaste: true, formatOnType: true,
      contextmenu: true, fixedOverflowWidgets: true,
      readOnly: latest.current.readOnly, domReadOnly: latest.current.readOnly,
    });
    editor.current = instance;
    comments.current = registerEditorComments(instance, message => latest.current.onError(message));
    const changed = instance.onDidChangeModelContent(() => {
      if (!applying.current) latest.current.onChange(instance.getValue());
    });
    const cursor = instance.onDidChangeCursorPosition(event => latest.current.onCursorChange({ line: event.position.lineNumber, column: event.position.column }));
    const selection = instance.onDidChangeCursorSelection(() => latest.current.onSelectionChange?.(selectedLines()));
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => latest.current.onSave());
    const attachAction = instance.addAction({
      id: 'canvagent.attachSelection', label: 'Add selection to chat',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyA],
      contextMenuGroupId: 'navigation', contextMenuOrder: 1.5,
      run: () => { if (!latest.current.readOnly) latest.current.onAttachSelection?.(selectedLines()); },
    });
    return () => {
      changed.dispose();
      cursor.dispose();
      selection.dispose();
      attachAction.dispose();
      comments.current?.dispose();
      comments.current = undefined;
      vimAdapter.current?.dispose();
      vimAdapter.current = undefined;
      instance.dispose();
      editor.current = undefined;
      for (const entry of models.current.values()) entry.model.dispose();
      models.current.clear();
      activeKey.current = undefined;
    };
  }, []);

  useEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    const key = `${props.projectKey}\0${props.path}`;
    const previous = activeKey.current && models.current.get(activeKey.current);
    const switching = activeKey.current !== key;
    if (switching && previous) previous.viewState = instance.saveViewState();
    let entry = models.current.get(key);
    if (!entry) {
      const uri = monaco.Uri.from({ scheme: 'canvagent', authority: encodeURIComponent(props.projectKey), path: `/${props.path}` });
      entry = { projectKey: props.projectKey, path: props.path, model: monaco.editor.createModel(props.content, undefined, uri), viewState: null };
      models.current.set(key, entry);
    }
    applying.current = true;
    try {
      if (entry.model.getValue() !== props.content) {
        // Applying a disk reload should not erase the file's entire undo history.
        entry.model.pushStackElement();
        entry.model.pushEditOperations(null, [{ range: entry.model.getFullModelRange(), text: props.content }], () => null);
        entry.model.pushStackElement();
      }
      if (switching) {
        activeKey.current = key;
        instance.setModel(entry.model);
        if (entry.viewState) instance.restoreViewState(entry.viewState);
      }
      instance.updateOptions({ readOnly: props.readOnly, domReadOnly: props.readOnly });
      for (const [storedKey, stored] of models.current) {
        if (storedKey !== key && (stored.projectKey !== props.projectKey || !props.openPaths.includes(stored.path))) {
          stored.model.dispose();
          models.current.delete(storedKey);
        }
      }
    } finally { applying.current = false; }
    if (switching) {
      const position = instance.getPosition();
      if (position) latest.current.onCursorChange({ line: position.lineNumber, column: position.column });
      latest.current.onReady?.();
    }
  }, [props.path, props.projectKey, props.content, props.readOnly, props.openPaths]);

  useEffect(() => {
    const instance = editor.current;
    if (!instance || !props.vimEnabled) return;
    const vim = initVimMode(instance, vimStatus.current);
    vimAdapter.current = vim;
    // monaco-vim's :write command calls the adapter's save hook when provided.
    Object.assign(vim, { save: () => latest.current.onSave() });
    return () => {
      if (vimAdapter.current === vim) { vim.dispose(); vimAdapter.current = undefined; }
    };
  }, [props.vimEnabled]);

  return <div className="monaco-code-editor" data-file-path={props.path} style={{ display: 'flex', flexDirection: 'column', flex: 1, width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}>
    <div ref={container} style={{ flex: 1, width: '100%', minHeight: 0 }} />
    <div ref={vimStatus} aria-label="Vim status" style={{ display: props.vimEnabled ? 'block' : 'none', flexShrink: 0, padding: '4px 12px', minHeight: 24, boxSizing: 'border-box', borderTop: '1px solid #ededf2', font: '11px SFMono-Regular, Menlo, monospace', color: '#6c6c79' }} />
  </div>;
});
