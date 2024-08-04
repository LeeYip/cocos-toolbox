import * as vscode from 'vscode';
import Config from '../config';

const REG_COLOR = /(?:#([0-9a-fA-F]{6,8}))|(?<![a-zA-Z_])(?:[Cc]olor)\((?:\s*(\d+)\s*)?(?:,\s*(\d+)\s*)?(?:,\s*(\d+)\s*)?(?:,\s*(\d+)\s*)?\)/g;

/**
 * 对特定格式的内容显示颜色色块
 */
export default class ColorToken {

    private static _init: boolean = false;

    private static _context: vscode.ExtensionContext;
    private static _colorProvider: vscode.Disposable;

    public static init(context: vscode.ExtensionContext): void {
        if (this._init)
            return;
        this._init = true;
        this._context = context;

        this.updateColorProvider();
    }

    public static updateColorProvider(): void {
        if (!this._context)
            return;

        // 取消现有的color provider
        this._colorProvider?.dispose();
        // 更新color provider
        let selector: vscode.DocumentFilter[] = [];
        Config.colorLanguages.forEach((v) => {
            selector.push({ scheme: 'file', language: v });
        });
        this._colorProvider = vscode.languages.registerColorProvider(selector, new ColorProvider());
        this._context.subscriptions.push(this._colorProvider);
    }

    public static setRgba(match: RegExpExecArray | null, rgba: [number, number, number, number], isHex: boolean): void {
        if (!match)
            return;

        if (isHex) {
            let arr = this.hexToRgba(match[1]);
            rgba[0] = arr[0] ?? 255;
            rgba[1] = arr[1] ?? 255;
            rgba[2] = arr[2] ?? 255;
            rgba[3] = arr[3] ?? 255;
        } else {
            rgba[0] = Number(match[2] ?? 0);
            rgba[1] = Number(match[3] ?? 0);
            rgba[2] = Number(match[4] ?? 0);
            rgba[3] = Number(match[5] ?? 255);
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
    public static rgbaToHex(rgba: [number, number, number, number], min: boolean = false): string {
        // 将每个通道的值转换为十六进制，并确保为两位数
        const rHex = Math.round(rgba[0]).toString(16).padStart(2, '0');
        const gHex = Math.round(rgba[1]).toString(16).padStart(2, '0');
        const bHex = Math.round(rgba[2]).toString(16).padStart(2, '0');
        const aHex = Math.round(rgba[3]).toString(16).padStart(2, '0');

        // 拼接并返回十六进制颜色值
        return min && rgba[3] === 255 ? `#${rHex}${gHex}${bHex}` : `#${rHex}${gHex}${bHex}${aHex}`;
    }
}

class ColorProvider implements vscode.DocumentColorProvider {
    public provideDocumentColors(document: vscode.TextDocument, token: vscode.CancellationToken): Thenable<vscode.ColorInformation[]> {
        return new Promise((resolve) => {
            let colors: vscode.ColorInformation[] = [];
            if (!Config.enableColor) {
                resolve(colors);
                return;
            }

            let text = document.getText();
            let match: RegExpExecArray | null = null;
            let rgba: [number, number, number, number] = [0, 0, 0, 0];
            REG_COLOR.lastIndex = 0;
            while ((match = REG_COLOR.exec(text))) {
                let fullMatch = match[0];
                let isHex = fullMatch[0] === "#";
                ColorToken.setRgba(match, rgba, isHex);

                let startPos: vscode.Position;
                let endPos: vscode.Position;
                if (isHex) {
                    startPos = document.positionAt(match.index);
                    endPos = document.positionAt(match.index + fullMatch.length);
                } else {
                    startPos = document.positionAt(match.index + fullMatch.indexOf("(") + 1);
                    endPos = document.positionAt(match.index + fullMatch.length - 1);
                }

                // 确保range合法
                if (startPos.isBefore(endPos)) {
                    colors.push(new vscode.ColorInformation(
                        new vscode.Range(startPos, endPos),
                        new vscode.Color(rgba[0] / 255, rgba[1] / 255, rgba[2] / 255, rgba[3] / 255))
                    );
                }
            }

            resolve(colors);
        });
    }

    public provideColorPresentations(color: vscode.Color, context: { document: vscode.TextDocument, range: vscode.Range }, token: vscode.CancellationToken): Thenable<vscode.ColorPresentation[]> {
        let text = context.document.getText(context.range);
        let isHex = text && text[0] === "#";
        let rgba: [number, number, number, number] = [Math.round(color.red * 255), Math.round(color.green * 255), Math.round(color.blue * 255), Math.round(color.alpha * 255)];
        let label = isHex ? ColorToken.rgbaToHex(rgba, true) : `${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rgba[3]}`;
        let presentation = new vscode.ColorPresentation(label);
        return new Promise((resolve) => {
            resolve([presentation]);
        });
    }
}
