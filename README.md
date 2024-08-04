# Cocos Toolbox
一个帮助提升Cocos Creator项目一点点开发体验的VS Code插件

## Features 
- 自动同步meta文件
    - 在VS Code中修改（如重命名、移动、删除）项目文件与目录时，同步修改对应的meta文件
    - 可在**设置 - CocosToolbox.enableMeta**中开关

- 颜色预览&选择
    - 对文件中形如`#9648ff`和`color(255, 90, 0)`格式的内容旁显示对应的颜色色块
    - 鼠标悬停在以上格式的颜色值时，在悬浮窗上展示颜色选择器
    - 可在**设置 - CocosToolbox.colorLanguages**中配置支持颜色预览的文件类型，默认支持类型为**javascript**、**typescript**、**json**
    - 可在**设置 - CocosToolbox.enableColor**中开关

    ![image](./image/color_token.jpg)</br>

- 右键菜单快速查找所有引用当前脚本的资源文件（场景和预制体）
    - 快捷键 **<kbd>ctrl(cmd)</kbd>+<kbd>alt</kbd>+<kbd>f</kbd>**

    ![image](./image/find.jpg)</br>