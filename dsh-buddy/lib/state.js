/**
 * dsh-buddy — 插件内共享运行时状态（迷你注册表）。
 *
 * 独立成模块的原因：agent.js（生产者）与 config.js（消费方，HTTP 路由）
 * 需要共享"最近活跃的 BuddyAgent"，直接互相 import 会成环；本模块无任何
 * 依赖，两端各取所需。
 *
 * latestAgent 的写入时机：agent 构造 + 每次 turn()（用户发消息）；
 * 清空时机：index.js _publishBuilt 的 dispose（会话销毁）。控制台的
 * "会话选择 / CLI 实际生效"两行状态与模型写回都作用于它。
 */
export const buddyRuntime = {
    /** 最近活跃的 BuddyAgent 实例；无活跃会话时为 null。 */
    latestAgent: null,
};
