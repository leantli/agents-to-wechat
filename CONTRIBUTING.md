# 贡献指南

感谢你考虑为 agents-to-wechat 贡献。

## 开发方式

- 从特性分支开始工作，不直接在 `main` 上开发
- 通过 Pull Request 合并到 `main`
- 每个会影响用户可见行为的改动都应补一个 changeset
- 代码提交使用 Conventional Commits

## 本地验证

在提交 PR 前运行：

```bash
npm test
npm run check
npm run lint
```

如果改动影响发布结果，再补：

```bash
npm run format:check
npm run build
npm pack --dry-run
```

## Changesets

- 用户可见的变更需要新增 `.changeset/*.md`
- 纯内部整理、不会影响发布内容的改动可以不写 changeset
- 发布前运行 `npm run version-packages`，同步更新版本号、`CHANGELOG.md` 和 `package-lock.json`
- 发布通过人工打 tag 触发，不在合并时自动发 npm
- CLI 版本号直接读取 `package.json`，不需要手工同步源码里的版本字符串

## 发布前检查

首次发布和后续版本都应确认：

- `README.md`、`README_EN.md`、`CHANGELOG.md`、`package.json` 的名称一致
- 安装命令使用 `agents-to-wechat`
- GitHub 仓库链接指向 `leantli/agents-to-wechat`
- `npm pack --dry-run` 输出的内容符合预期
- GitHub Actions secrets 已配置 `NPM_TOKEN`
- 首次发布继续使用 `npm publish --access public --provenance`

## 报告问题

请在 GitHub Issues 中提供：

- 操作系统和 Node.js 版本
- 复现步骤
- 预期行为和实际行为
- 相关日志

## 许可证

贡献的代码将采用与项目相同的 MIT License。
