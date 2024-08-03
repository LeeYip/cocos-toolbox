import * as fs from 'fs';
import * as vscode from 'vscode';
import Config from '../config';
import Utils from '../utils/utils';

/**
 * meta文件同步
 */
export default class MetaSync {

    public static onDidDeleteFiles(files: readonly vscode.Uri[]): void {
        if (!Config.enableMeta)
            return;

        let file: vscode.Uri;
        for (let i = 0; i < files.length; i++) {
            file = files[i];
            this.deleteMeta(file);
        }
    }

    public static onDidRenameFiles(files: readonly { readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri; }[]): void {
        if (!Config.enableMeta)
            return;

        let file: { readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri; };
        for (let i = 0; i < files.length; i++) {
            file = files[i];
            this.renameMeta(file.oldUri, file.newUri);
        }
    }

    /**
     * 删除文件后，同步删除对应的meta文件
     */
    private static async deleteMeta(oldUri: vscode.Uri): Promise<void> {
        try {
            const oldFilePath = oldUri.fsPath;
            const metaFilePath = `${oldFilePath}.meta`;

            // 检查.meta文件是否存在
            if (await Utils.checkPath(metaFilePath)) {
                await fs.promises.unlink(metaFilePath);
                console.log(`delete ${metaFilePath}`);
            }
        } catch (error) {
            console.error(`Failed to delete ${oldUri.fsPath}.meta: ${error}`);
        }
    }

    /**
     * 重命名文件后，同步重命名对应的meta文件
     */
    private static async renameMeta(oldUri: vscode.Uri, newUri?: vscode.Uri): Promise<void> {
        try {
            // 从旧URI获取文件名和目录  
            const oldFilePath = oldUri.fsPath;
            // 构建.meta文件的路径  
            const metaFilePath = `${oldFilePath}.meta`;

            // 检查.meta文件是否存在  
            if (await Utils.checkPath(metaFilePath)) {
                // 如果存在，则构建新的.meta文件路径（如果需要的话）  
                let newMetaFilePath = metaFilePath;
                if (newUri) {
                    const newFilePath = newUri.fsPath;
                    newMetaFilePath = `${newFilePath}.meta`;
                }

                // 尝试重命名.meta文件  
                await fs.promises.rename(metaFilePath, newMetaFilePath);
                console.log(`Renamed ${metaFilePath} to ${newMetaFilePath}`);
            }
        } catch (error) {
            console.error(`Failed to rename ${oldUri.fsPath} to ${oldUri.fsPath}.meta: ${error}`);
        }
    }
}
