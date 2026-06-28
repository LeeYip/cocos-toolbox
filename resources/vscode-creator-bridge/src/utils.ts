/**
 * 工具函数
 */
export default class Utils {

    /**
     * 等待指定毫秒数
     * @param ms 等待毫秒数
     * */
    public static sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }
}