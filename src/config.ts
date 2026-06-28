import * as vscode from "vscode";

/**
 * 插件配置项
 */
export default class Config {
    public static readonly enableMetaId: string = "CocosToolbox.enableMeta";
    public static readonly enableColorId: string = "CocosToolbox.enableColor";
    public static readonly colorLanguagesId: string = "CocosToolbox.colorLanguages";
    public static readonly creatorBridgeRequestTimeoutId: string = "CocosToolbox.creatorBridgeRequestTimeout";

    private static _init: boolean = false;

    private static _enableMeta: boolean = true;
    public static get enableMeta(): boolean {
        return this._enableMeta;
    }

    private static _enableColor: boolean = true;
    public static get enableColor(): boolean {
        return this._enableColor;
    }

    private static _colorLanguages: string[] = [];
    public static get colorLanguages(): string[] {
        return this._colorLanguages;
    }

    private static _creatorBridgeRequestTimeout: number = 3000;
    public static get creatorBridgeRequestTimeout(): number {
        return this._creatorBridgeRequestTimeout;
    }

    public static init(_context: vscode.ExtensionContext): void {
        if (this._init) {
            return;
        }
        this._init = true;

        this.refresh();
    }

    public static refresh(): void {
        const config = vscode.workspace.getConfiguration();
        this._enableMeta = config.get(this.enableMetaId, true);
        this._enableColor = config.get(this.enableColorId, true);
        this._colorLanguages = config.get(this.colorLanguagesId, []);
        this._creatorBridgeRequestTimeout = config.get(this.creatorBridgeRequestTimeoutId, 3000);
    }
}
