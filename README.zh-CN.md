# dsh-lineage

[![CI](https://github.com/dongsheng123132/dsh-lineage/actions/workflows/check.yml/badge.svg)](https://github.com/dongsheng123132/dsh-lineage/actions/workflows/check.yml)
[![MIT 许可证](https://img.shields.io/github/license/dongsheng123132/dsh-lineage)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Awesome DSH Plugins](https://img.shields.io/badge/Awesome_DSH-%E5%B7%B2%E9%AA%8C%E8%AF%81%E5%AE%9E%E9%AA%8C-0969da)](https://github.com/dongsheng123132/awesome-dsh-plugins/blob/main/README.zh-CN.md#2origin-%E6%8F%92%E4%BB%B6%E5%AE%9E%E9%AA%8C%E5%AE%A4)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 的内容寻址数据/动作血缘证据。

DSH 生态已有安全审计插件扫描“插件从哪里来”；`dsh-lineage` 解决的是另一层：为 artifact、已验证 fact 记录、action 和 report 建立本地可复核对象图。它不保存聊天记录或事实正文；节点只包含类型化 ID、工作区相对对象引用与期望 SHA-256。

## 图模型

节点类型：`artifact`、`fact`、`action`、`report`。

关系边从依赖对象指向来源：

- `derived-from`
- `observed-by`
- `produced-by`
- `supersedes`

验证器会在 `workspaceRoot` 内解引用每个节点并重算哈希，明确区分：

- `verified`：对象存在且哈希一致；
- `missing`：引用不存在；
- `stale`：对象存在但哈希已变化；
- 悬空节点引用、关系类型错误与图循环。

缺失或陈旧对象绝不会被静默升级成事实。

## Append-only 账本

输入是显式 JSONL。每个事件带 `idempotencyKey`，操作为 `put-node` 或 `put-edge`。一个 key 对应 `ledgerDir` 中一个不可变事件文件：

1. 写入前验证完整假设图；
2. 在显式 ledgerDir 内写临时文件；
3. 回读临时文件；
4. 通过硬链接原子发布到最终不可变槽位；
5. 再次回读并校验 SHA-256。

同 key 同事件可以安全重放；同 key 不同内容会拒绝。既有事件永不修改；新 revision 使用新节点 ID，并通过 `supersedes` 连接旧节点。

## 安全边界

- ledger、JSONL、对象和报告路径都必须是工作区相对路径；拒绝目录穿越和 symlink 组件。
- 只向显式 `ledgerDir` 或 `artifactDir` 写入。
- 事件只允许结构化 ID、类型、路径与哈希；claim、聊天、prompt、message、正文、text、凭证、token、Cookie 和 Authorization 等字段直接拒绝。
- 对象正文只参与哈希，不复制进账本或报告。
- 发布前拒绝自环、DAG 循环以及错误的 producer/observer/supersedes 类型关系。
- 闭包报告内容寻址并回读校验。

哈希只能证明对象身份，不能自动证明内容真实。插件只披露现有、缺失或变化的证据，不发明断言。

## 安装到 DSH

```bash
dsh plugin --profile lineage add github:dongsheng123132/dsh-lineage
```

注册四个工具：

- `dsh_lineage_inspect`
- `dsh_lineage_ingest`
- `dsh_lineage_query`
- `dsh_lineage_verify`

## 命令行

```bash
dsh-lineage ingest --root D:/project --ledger ledger --events lineage.events.jsonl
dsh-lineage inspect --root D:/project --ledger ledger
dsh-lineage query --root D:/project --ledger ledger --node report:proof --direction upstream
dsh-lineage verify --root D:/project --ledger ledger --node report:proof --direction upstream --artifact-dir artifacts
```

查询方向支持 `upstream`、`downstream`、`both`。验证闭包全部健康时退出 `0`；报告已写出但存在缺失/陈旧/无效证据时退出 `2`；运行或 schema 错误退出 `1`。

完整示例见 [`examples/lineage.events.jsonl`](examples/lineage.events.jsonl)。

## 开发验证

```bash
npm test
npm run check
npm run smoke:plugin
```

要求 Node.js 22+。没有安装生命周期脚本；运行依赖只有可选的 DSH tools SDK peer。

## 许可证

MIT
