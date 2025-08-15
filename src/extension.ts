import * as vscode from 'vscode';
import * as path from 'path';

function matchesPattern(uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') {
    return false;
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return false;
  }
  const relative = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
  const parts = relative.split(path.sep);
  if (parts.length < 2) {
    return false;
  }
  const [dir, ...rest] = parts;
  return /^base_.+/.test(dir) && rest.join(path.sep).endsWith('.py');
}

export function activate(context: vscode.ExtensionContext) {
  const command = 'deflateViz.showPreview';

  const updateContext = (editor: vscode.TextEditor | undefined) => {
    const active = !!editor && matchesPattern(editor.document.uri);
    vscode.commands.executeCommand('setContext', 'deflateViz.hasPreview', active);
  };

  updateContext(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateContext));

  const disposable = vscode.commands.registerCommand(command, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    try {
      const response = await fetch('http://localhost:5000/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: editor.document.getText() })
      });
      const data = await response.json();

      const resultPanel = vscode.window.createWebviewPanel(
        'deflateVizResult',
        'Compression Result',
        vscode.ViewColumn.Beside,
        {}
      );
      resultPanel.webview.html = `<pre>${data.compressed}</pre>`;

      const blockPanel = vscode.window.createWebviewPanel(
        'deflateVizBlocks',
        'Block Info',
        vscode.ViewColumn.Beside,
        {}
      );
      blockPanel.webview.html = `<pre>${data.blocks}</pre>`;
    } catch (err) {
      vscode.window.showErrorMessage(`Compression failed: ${err}`);
    }
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
