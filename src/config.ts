import * as vscode from 'vscode';
import ColorToken from './features/colorToken';

/**
 * 插件配置项
 */
export default class Config {

    public static readonly enableMetaId: string = 'CocosToolbox.enableMeta';
    public static readonly enableColorId: string = 'CocosToolbox.enableColor';
    public static readonly colorLanguagesId: string = 'CocosToolbox.colorLanguages';

    private static _init: boolean = false;

    private static _enableMeta: boolean = true;
    public static get enableMeta(): boolean { return this._enableMeta; }

    private static _enableColor: boolean = true;
    public static get enableColor(): boolean { return this._enableColor; }

    private static _colorLanguages: string[] = [];
    public static get colorLanguages(): string[] { return this._colorLanguages; }

    public static init(context: vscode.ExtensionContext): void {
        if (this._init)
            return;
        this._init = true;

        this._enableMeta = vscode.workspace.getConfiguration().get(this.enableMetaId, true);
        this._enableColor = vscode.workspace.getConfiguration().get(this.enableColorId, true);
        this._colorLanguages = vscode.workspace.getConfiguration().get(this.colorLanguagesId, []);

        // 监听配置变化
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(this.enableMetaId)) {
                this._enableMeta = vscode.workspace.getConfiguration().get(this.enableMetaId, true);
            } else if (e.affectsConfiguration(this.enableColorId)) {
                this._enableColor = vscode.workspace.getConfiguration().get(this.enableColorId, true);
            } else if (e.affectsConfiguration(this.colorLanguagesId)) {
                this._colorLanguages = vscode.workspace.getConfiguration().get(this.colorLanguagesId, []);
                ColorToken.updateColorProvider();
            }
        }));
    }
}
