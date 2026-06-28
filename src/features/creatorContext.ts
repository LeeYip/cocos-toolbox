import * as vscode from "vscode";
import { isCocosCreatorProjectRoot } from "./creatorBridgeInstaller";

const COCOS_PROJECT_CONTEXT_KEY = "CocosToolbox.isCocosProject";

/**
 * Cocos Creator 项目上下文状态
 */
export default class CreatorContext {
    public static init(context: vscode.ExtensionContext): void {
        void this.update();
        context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                void this.update();
            }),
        );
    }

    private static async update(): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            await this.setContext(false);
            return;
        }

        for (const folder of workspaceFolders) {
            if (await isCocosCreatorProjectRoot(folder.uri.fsPath)) {
                await this.setContext(true);
                return;
            }
        }

        await this.setContext(false);
    }

    private static async setContext(isCocosProject: boolean): Promise<void> {
        await vscode.commands.executeCommand("setContext", COCOS_PROJECT_CONTEXT_KEY, isCocosProject);
    }
}
