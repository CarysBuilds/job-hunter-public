# Job Hunter

Job Hunter 是一个以 Windows 为优先支持平台的本地求职助手，用于职位发现、匹配和投递跟踪。

它会在你自己的 Chrome 用户配置中打开官方招聘网站，让你手动触发搜索，将结果保存到本地 SQLite 数据库，并根据你首次启动时配置的个人资料为职位打分。

## Windows 快速开始

1. 从 GitHub Releases 下载 `JobHunter-Setup-x64.exe`。
2. 安装程序无需管理员权限。
3. 从开始菜单或桌面快捷方式打开 Job Hunter。
4. 完成初始化设置：目标岗位、城市、薪资、经验、关键词，以及可选的 LLM API。
5. 点击平台登录按钮，在 Chrome 中完成登录，然后点击抓取按钮。

首个公开版本面向 Windows 10/11 x64。面向贡献者的 macOS 开发命令仍然可用，但打包后的用户体验以 Windows 为优先。

## 隐私边界

- 数据库、简历、日志、Chrome 用户配置和设置都会保留在你的本机。
- 本地 Web 服务默认只监听本机地址，并拒绝非本机 Host 或写操作来源。
- 应用不会导出 Cookie。
- 只有在你手动登录并手动触发抓取后，应用才会访问招聘平台。
- 招呼语生成只会把你配置的简历和选中的职位描述发送给你自行配置的 LLM API。
- 公开版本只生成招呼语草稿，不会自动发送消息。

更多细节见 [docs/privacy.md](docs/privacy.md)。

## 开发环境

```bash
npm install
npm run typecheck
npm test
npm run build
npm run scan:sensitive
```

运行本地 Web 应用：

```bash
npm run mock
npm run dev
```

打开 <http://localhost:3000>。

## 打包

Windows 打包配置位于 `packaging/windows/`，可通过以下命令生成：

```bash
npm run build
npm run scan:sensitive
npm run package:windows
```

在 Windows CI 中，GitHub Actions 会构建 `JobHunter-Setup-x64.exe`，并将其作为 release artifact 发布。

## 平台支持

- BOSS：主要支持路径。
- 猎聘和智联招聘：实验性适配器；默认延迟更慢，并且可能需要人工确认。
- 所有平台访问都需要手动触发，并且仅在本地进行。

## 仓库安全

这个公开仓库应从干净目录初始化，不能继承私有 Git 历史。请勿提交：

- `.env`
- SQLite 数据库
- 简历
- 日志
- Chrome 用户配置
- 诊断信息
- 安装器暂存输出

在提交或创建发布版本前，请运行 `npm run scan:sensitive`。
