import * as path from "path";
import * as vscode from "vscode";
import { ensureCreatorBridgeReady, isCocosCreatorProjectRoot } from "./creatorBridgeInstaller";
import { openAssetInCreator, revealAssetInCreator, toCreatorAssetPath } from "./creatorBridgeClient";

/**
 * 在 Cocos Creator 中显示资源文件
 */
export default class CreatorAssetShower {
    public static readonly command: string = "CocosToolbox.showAssetInCreator";

    private static _init: boolean = false;
    private static _extensionPath: string = "";

    public static init(context: vscode.ExtensionContext): void {
        if (this._init) {
            return;
        }
        this._init = true;
        this._extensionPath = context.extensionPath;

        const showListener = vscode.commands.registerCommand(this.command, async (uri?: vscode.Uri) => {
            await this.show(uri);
        });

        context.subscriptions.push(showListener);
    }

    private static async show(uri?: vscode.Uri): Promise<void> {
        const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) {
            return;
        }

        const filePath = targetUri.fsPath;
        if (filePath.toLowerCase().endsWith(".meta")) {
            vscode.window.showWarningMessage("Meta 文件不能直接在 Cocos Creator 中显示，请选择对应资源文件。");
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri);
        if (!workspaceFolder) {
            vscode.window.showWarningMessage("请选择工作区内的 Cocos Creator 资源文件。");
            return;
        }

        if (!(await isCocosCreatorProjectRoot(workspaceFolder.uri.fsPath))) {
            vscode.window.showWarningMessage("当前文件不属于 Cocos Creator 项目。");
            return;
        }

        const assetPath = toCreatorAssetPath(filePath, workspaceFolder.uri.fsPath);
        if (!assetPath || assetPath === "assets") {
            vscode.window.showWarningMessage("请选择 assets 目录下的 Cocos Creator 资源文件。");
            return;
        }

        await ensureCreatorBridgeReady(this._extensionPath, filePath);
        const result = this.shouldOpenAsset(filePath) ? await openAssetInCreator(filePath) : await revealAssetInCreator(filePath);
        if (!result.success) {
            vscode.window.showWarningMessage(result.error || `无法在 Cocos Creator 中显示 ${path.basename(filePath)}。`);
        }
    }

    private static shouldOpenAsset(filePath: string): boolean {
        const extname = path.extname(filePath).toLowerCase();
        return extname === ".prefab" || extname === ".fire" || extname === ".scene";
    }
}
