import * as vscode from 'vscode';
import Config from './config';
import ColorToken from './features/colorToken';
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

	// 将事件监听器注册到 context，以便在插件停用时自动取消监听
	context.subscriptions.push(fileDeleteListener, fileRenameListener);

	Config.init(context);
	ColorToken.init(context);
	FindAssets.init(context);
}

export function deactivate() { }
