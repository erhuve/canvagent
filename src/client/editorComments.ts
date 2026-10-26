import { getJavaScriptWorker, getTypeScriptWorker, monaco } from './monaco';

type TextChange = { span: { start: number; length: number }; newText: string };
type CommentWorker = {
  getJsxCommentEdits(fileName: string, ranges: { pos: number; end: number }[], insertSpace: boolean): Promise<TextChange[] | null>;
};

export function registerEditorComments(editor: monaco.editor.IStandaloneCodeEditor, onError: (message: string) => void) {
  const original = editor.getAction('editor.action.commentLine');
  let disposed = false;
  let pending = Promise.resolve();
  const toggle = async (requestedModel: monaco.editor.ITextModel) => {
    if (disposed || editor.getModel() !== requestedModel || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
    if (!/\.[jt]sx$/i.test(requestedModel.uri.path)) { await original?.run(); return; }
    const selections = editor.getSelections();
    if (!selections?.length) return;
    const version = requestedModel.getVersionId();
    const ranges = selections.map(selection => ({
      pos: requestedModel.getOffsetAt(selection.getStartPosition()),
      end: requestedModel.getOffsetAt(selection.getEndPosition()),
    }));
    const getWorker = requestedModel.getLanguageId() === 'javascript' ? getJavaScriptWorker : getTypeScriptWorker;
    const worker = await (await getWorker())(requestedModel.uri) as unknown as CommentWorker;
    const changes = await worker.getJsxCommentEdits(requestedModel.uri.toString(), ranges, editor.getOption(monaco.editor.EditorOption.comments).insertSpace);
    // A worker response must never overwrite typing or affect a newly opened file.
    if (disposed || requestedModel.isDisposed() || editor.getModel() !== requestedModel || requestedModel.getVersionId() !== version || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
    const currentSelections = editor.getSelections();
    if (!currentSelections || currentSelections.length !== selections.length || !selections.every((selection, index) => selection.equalsSelection(currentSelections[index]))) return;
    if (changes === null) { await original?.run(); return; }
    if (!changes.length) return;
    const edits = changes.map(change => {
      const start = requestedModel.getPositionAt(change.span.start);
      const end = requestedModel.getPositionAt(change.span.start + change.span.length);
      return { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: change.newText };
    });
    // One undo step, with Monaco tracking all cursors through the insertion or
    // removal of comment delimiters rather than resetting the selection.
    const tracked = editor.createDecorationsCollection(selections.map(selection => ({
      range: selection,
      options: { stickiness: !selection.isEmpty() ? monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
        : selection.startColumn === requestedModel.getLineMaxColumn(selection.startLineNumber)
          ? monaco.editor.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore : monaco.editor.TrackedRangeStickiness.GrowsOnlyWhenTypingAfter },
    })));
    try {
      editor.pushUndoStop();
      editor.executeEdits('editor.action.commentLine', edits, () => selections.map((selection, index) => {
        const range = tracked.getRange(index) ?? selection;
        return selection.getDirection() === monaco.SelectionDirection.LTR
          ? new monaco.Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn)
          : new monaco.Selection(range.endLineNumber, range.endColumn, range.startLineNumber, range.startColumn);
      }));
      editor.pushUndoStop();
    } finally { tracked.clear(); }
  };
  const action = editor.addAction({
    id: 'editor.action.commentLine', label: 'Toggle Line Comment',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash],
    precondition: '!editorReadonly', keybindingContext: 'editorTextFocus',
    run: () => {
      const model = editor.getModel();
      if (!model) return;
      pending = pending.then(() => toggle(model)).catch(() => {
        if (!disposed) onError('Could not determine the comment syntax. Your file was left unchanged; please try again.');
      });
      return pending;
    },
  });
  return {
    whenIdle: () => pending,
    dispose: () => { disposed = true; action.dispose(); },
  };
}
