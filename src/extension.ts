import * as vscode from "vscode";
import Config from "./config";
import ColorToken from "./features/colorToken";
import CreatorAssetShower from "./features/creatorAssetShower";
import CreatorContext from "./features/creatorContext";
import FindReferences from "./features/findReferences";
import MetaSync from "./features/metaSync";

export function activate(context: vscode.ExtensionContext) {
    Config.init(context);
    CreatorContext.init(context);
    CreatorAssetShower.init(context);
    ColorToken.init(context);
    if (Config.enableColor) {
        ColorToken.enable();
    }
    FindReferences.init(context);

    // 监听设置变动
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            Config.refresh();
            // ColorToken相关设置变动后更新显示
            if (event.affectsConfiguration(Config.enableColorId) || event.affectsConfiguration(Config.colorLanguagesId)) {
                ColorToken.updateColorProvider();
            }
        }),
    );

    // 监听文件删除事件
    let fileDeleteListener = vscode.workspace.onDidDeleteFiles((event) => {
        MetaSync.onDidDeleteFiles(event.files);
    });
    // 监听文件重命名事件
    let fileRenameListener = vscode.workspace.onDidRenameFiles((event) => {
        MetaSync.onDidRenameFiles(event.files);
    });
    // 将事件监听器注册到 context，以便在插件停用时自动取消监听
    context.subscriptions.push(fileDeleteListener, fileRenameListener);
}

export function deactivate() { }
