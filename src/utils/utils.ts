import * as fs from 'fs';

/**
 * 工具函数
 */
export default class Utils {

    /**
     * 判断文件是否存在
     */
    public static async checkPath(path: string): Promise<boolean> {
        return await fs.promises.access(path).then(() => true).catch(() => false);
    }
}
