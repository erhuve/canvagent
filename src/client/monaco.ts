import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import TypeScriptWorker from './typescript.worker.js?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker.js?worker';
import CssWorker from 'monaco-editor/languages/features/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker.js?worker';

import '../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import '../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/features/find/register.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/codeAction/browser/codeActionContributions.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/format/browser/formatActions.js';
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError.js';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/editor/contrib/links/browser/links.js';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js';
import 'monaco-editor/editor/contrib/rename/browser/rename.js';
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js';
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization.js';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js';
import 'monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js';

import 'monaco-editor/languages/definitions/cpp/register.js';
import 'monaco-editor/languages/definitions/css/register.js';
import 'monaco-editor/languages/definitions/dockerfile/register.js';
import 'monaco-editor/languages/definitions/go/register.js';
import 'monaco-editor/languages/definitions/html/register.js';
import 'monaco-editor/languages/definitions/ini/register.js';
import 'monaco-editor/languages/definitions/java/register.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/rust/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';
import 'monaco-editor/languages/definitions/sql/register.js';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/xml/register.js';
import 'monaco-editor/languages/definitions/yaml/register.js';
import 'monaco-editor/languages/features/css/register.js';
import 'monaco-editor/languages/features/html/register.js';
import 'monaco-editor/languages/features/json/register.js';
import { javascriptDefaults, typescriptDefaults, JsxEmit, ModuleKind, ModuleResolutionKind, ScriptTarget } from 'monaco-editor/languages/features/typescript/register.js';

// Every worker is bundled with the app; the editor never fetches code from a CDN.
globalThis.MonacoEnvironment = {
  ...globalThis.MonacoEnvironment,
  getWorker(_workerId, label) {
    if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
    if (label === 'json') return new JsonWorker();
    if (['css', 'scss', 'less'].includes(label)) return new CssWorker();
    if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker();
    return new EditorWorker();
  },
};

const compilerOptions = {
  target: ScriptTarget.ES2020, module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.NodeJs,
  jsx: JsxEmit.Preserve, allowNonTsExtensions: true, allowJs: true, noEmit: true, resolveJsonModule: true,
};
typescriptDefaults.setCompilerOptions(compilerOptions);
javascriptDefaults.setCompilerOptions(compilerOptions);
typescriptDefaults.setEagerModelSync(true);
javascriptDefaults.setEagerModelSync(true);
javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });

monaco.editor.defineTheme('canvagent-light', {
  base: 'vs', inherit: true, rules: [],
  colors: {
    'editor.background': '#ffffff', 'editor.foreground': '#3c3c43',
    'editorLineNumber.foreground': '#b3b3be', 'editorLineNumber.activeForeground': '#6c6c79',
    'editor.selectionBackground': '#e5e3fa', 'editor.inactiveSelectionBackground': '#efeff6',
    'editor.lineHighlightBackground': '#fafafd', 'editorIndentGuide.background1': '#ededf2',
    'editorWidget.background': '#ffffff', 'editorWidget.border': '#e1e1e8',
    'focusBorder': '#9a96c5',
  },
});

export { monaco };
export { getJavaScriptWorker, getTypeScriptWorker } from 'monaco-editor/languages/features/typescript/register.js';
