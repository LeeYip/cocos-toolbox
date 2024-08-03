import * as vscode from 'vscode';
import Config from '../config';

const REG_HEX = /(?:#([0-9a-fA-F]{6,8}))/;
const REG_RGBA = /(?<![a-zA-Z_])(?:[Cc]olor)\((?:\s*(\d+)\s*)?(?:,\s*(\d+)\s*)?(?:,\s*(\d+)\s*)?(?:,\s*(\d+)\s*)?\)/;
const REG_COLOR = /(?:#([0-9a-fA-F]{6,8}))|(?<![a-zA-Z_])(?:[Cc]olor)\((?:\s*(\d+)\s*)?(?:,\s*(\d+)\s*)?(?:,\s*(\d+)\s*)?(?:,\s*(\d+)\s*)?\)/g;

/**
 * 对特定格式的内容显示颜色色块
 */
export default class ColorBlock {

    private static _init: boolean = false;
    private static _colorBlockType: vscode.TextEditorDecorationType;

    public static init(context: vscode.ExtensionContext): void {
        if (this._init)
            return;
        this._init = true;

        // 定义Decoration Type
        this._colorBlockType = vscode.window.createTextEditorDecorationType({});
        // 初次加载时更新装饰
        if (vscode.window.activeTextEditor) {
            this.updateDecorations(vscode.window.activeTextEditor);
        }

        context.subscriptions.push(this._colorBlockType);
    }

    /**
     * 更新文本编辑器装饰
     */
    public static updateDecorations(editor: vscode.TextEditor): void {
        try {
            if (!Config.enableColor || !this._colorBlockType)
                return;

            const text = editor.document.getText();
            const newDecorations: vscode.DecorationOptions[] = [];

            let match: RegExpExecArray | null = null;
            let rgba: [number, number, number, number] = [0, 0, 0, 0];
            while ((match = REG_COLOR.exec(text))) {
                const fullMatch = match[0];
                this.setRgba(match, rgba);
                let isHex = fullMatch[0] === "#";
                const startPos = editor.document.positionAt(match.index);
                const endPos = editor.document.positionAt(match.index + (isHex ? fullMatch.length : fullMatch.length - 1));

                // Create decoration options with htmlContent
                const decoration = {
                    range: new vscode.Range(endPos, endPos.translate(0, 1)),
                    renderOptions: {
                        before: {
                            contentText: '\u200b', // Zero-width space to ensure the block renders
                            backgroundColor: `rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3] / 255})`,
                            width: '12px',
                            height: '12px',
                            border: '1.5px solid rgba(255,255,255,1)',
                            margin: '0px 2px 1.4px',
                            verticalAlign: 'middle'
                        }
                    }
                };
                newDecorations.push(decoration);
            }
            editor.setDecorations(this._colorBlockType, newDecorations);
        } catch (error) {
            console.error(`Failed to updateDecorations: ${error}`);
        }
    }

    /**
     * 绘制悬浮窗
     */
    public static provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
        try {
            if (!Config.enableColor)
                return;

            const text = document.getText();
            let match: RegExpExecArray | null = null;
            let rgba: [number, number, number, number] = [0, 0, 0, 0];
            while ((match = REG_COLOR.exec(text))) {
                const fullMatch = match[0];
                this.setRgba(match, rgba);
                let isHex = fullMatch[0] === "#";
                const start = match.index;
                const end = start + fullMatch.length;
                const range = new vscode.Range(document.positionAt(start + (isHex ? 0 : 5)), document.positionAt(end));

                if (range.contains(position)) {
                    const hoverMessage = this.getHoverContent(rgba);
                    return new vscode.Hover(hoverMessage, range);
                }
            }
        } catch (error) {
            console.error(`Failed to provideHover: ${error}`);
        }
    }

    public static getHoverContent(rgba: [number, number, number, number]): vscode.MarkdownString {
        let hex = this.rgbaToHex(rgba);
        let hoverStr = new vscode.MarkdownString();
        hoverStr.isTrusted = true;
        hoverStr.supportHtml = true;
        hoverStr.appendMarkdown(`<strong>RGBA: (${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rgba[3]})</strong>`);
        hoverStr.appendMarkdown('<br>');
        hoverStr.appendMarkdown(`<strong>HEX: ${hex}</strong>`);
        return hoverStr;
    }

    public static setRgba(match: RegExpExecArray | null, rgba: [number, number, number, number]): void {
        if (!match)
            return;

        const fullMatch = match[0];
        if (REG_RGBA.test(fullMatch)) {
            rgba[0] = Number(match[2] ?? 0);
            rgba[1] = Number(match[3] ?? 0);
            rgba[2] = Number(match[4] ?? 0);
            rgba[3] = Number(match[5] ?? 255);
        } else {
            let arr = this.hexToRgba(match[1]);
            rgba[0] = arr[0] ?? 255;
            rgba[1] = arr[1] ?? 255;
            rgba[2] = arr[2] ?? 255;
            rgba[3] = arr[3] ?? 255;
        }
    }

    /**
     * 16进制字符串转rgba数组
     * @param hex 16进制字符串
     */
    public static hexToRgba(hex: string): [number, number, number, number] {
        // 去除开头的 '#'，并转为小写
        hex = hex.replace(/^#/, '').toLowerCase();

        // 如果颜色值是三位数的缩写，则进行扩展
        if (hex.length === 3) {
            hex = hex.split('').map(function (c) {
                return c + c;
            }).join('');
        }

        // 解析 R、G、B 组件
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);

        // 默认设置完全不透明
        let a = 255;

        // 如果十六进制颜色字符串包含 alpha 通道，则解析 alpha 值
        if (hex.length === 8) {
            a = parseInt(hex.substring(6, 8), 16);
        }

        // 返回 RGBA 格式字符串
        return [r, g, b, a];
    }

    /**
     * rgba数组转16进制字符串
     * @param rgba rgba数组
     */
    public static rgbaToHex(rgba: [number, number, number, number]): string {
        // 将每个通道的值转换为十六进制，并确保为两位数
        const rHex = Math.round(rgba[0]).toString(16).padStart(2, '0');
        const gHex = Math.round(rgba[1]).toString(16).padStart(2, '0');
        const bHex = Math.round(rgba[2]).toString(16).padStart(2, '0');

        // 将透明度值转换为十六进制
        const aHex = Math.round(rgba[3]).toString(16).padStart(2, '0');

        // 拼接并返回十六进制颜色值
        return `#${rHex}${gHex}${bHex}${aHex}`;
    }
}
