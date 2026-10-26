import { initialize, TypeScriptWorker, ts } from 'monaco-editor/languages/features/typescript/ts.worker.js';
import { jsxCommentEdits } from '../shared/jsx-comments';

class CanvagentTypeScriptWorker extends TypeScriptWorker {
  async getJsxCommentEdits(fileName, ranges, insertSpace) {
    const service = this.getLanguageService();
    const source = service.getProgram()?.getSourceFile(fileName);
    if (!source) throw new Error('The editor syntax model is unavailable. Please try again.');
    return jsxCommentEdits(ts.typescript, service, source, ranges, insertSpace);
  }
}

// Monaco first posts an ignored bootstrap message, then the worker createData.
self.onmessage = () => initialize((context, createData) => new CanvagentTypeScriptWorker(context, createData));
