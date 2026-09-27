# Windows 朋友版安装说明

1. 安装 Google Chrome。
2. 双击 `JobHunter-Friend-Setup-x64.exe`，按提示安装。
3. 从桌面或开始菜单打开 **Job Hunter Friend**。
4. 浏览器未自动打开时，访问 [本机操作界面](http://127.0.0.1:17322)。

支持 Windows 10/11 x64，运行环境已包含在安装包中。Chrome 需单独安装。

## 数据目录

- 程序：`%LOCALAPPDATA%\Programs\JobHunterFriend`
- 个人数据：`%APPDATA%\JobHunterFriend\data`

模板、简历、岗位和登录状态都保存在个人数据目录，与公开通用版分开。

## 卸载

在 Windows 应用设置中卸载 Job Hunter Friend。卸载会保留个人数据，方便重新安装。需要彻底删除时，先退出程序和它打开的 Chrome 窗口，再删除上述个人数据目录。
