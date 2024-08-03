import * as vscode from 'vscode';
import Config from './config';
import ColorBlock from './features/colorBlock';
import FindAssets from './features/findAssets';
import MetaSync from './features/metaSync';

export function activate(context: vscode.ExtensionContext) {
	console.log('Cocos Toolbox is now active!');

	// 监听文件删除事件  
	let fileDeleteListener = vscode.workspace.onDidDeleteFiles(event => {
		MetaSync.onDidDeleteFiles(event.files);
	});

	// 监听文件重命名事件
	let fileRenameListener = vscode.workspace.onDidRenameFiles(event => {
		MetaSync.onDidRenameFiles(event.files);
	});

	// 监听文档激活
	let editorActiveListener = vscode.window.onDidChangeActiveTextEditor(editor => {
		if (editor) {
			ColorBlock.updateDecorations(editor);
		}
	});

	// 监听文本内容变化
	let editorChangeListener = vscode.workspace.onDidChangeTextDocument(event => {
		if (vscode.window.activeTextEditor && event.document === vscode.window.activeTextEditor.document) {
			ColorBlock.updateDecorations(vscode.window.activeTextEditor);
		}
	});

	// 监听鼠标悬停
	let hoverLinstener = vscode.languages.registerHoverProvider({ scheme: 'file' }, {
		provideHover(document, position, token) {
			return ColorBlock.provideHover(document, position, token);
		}
	});

	// 将事件监听器注册到 context，以便在插件停用时自动取消监听
	context.subscriptions.push(fileDeleteListener, fileRenameListener, editorActiveListener, editorChangeListener, hoverLinstener);

	Config.init(context);
	ColorBlock.init(context);
	FindAssets.init(context);
}

export function deactivate() { }
