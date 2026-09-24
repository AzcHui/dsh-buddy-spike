/**
 * buddy-llm-codebuddy — 把 CodeBuddy 的官方模型目录注册进 dsh 的 LLM 注册表。
 *
 * 作用（docs/user/develop/practice/llm-adapter.zh.md 的正规用法）：
 *   1. 注册 provider 路由 `codebuddy` → 设置页「模型」出现 CodeBuddy 卡片，
 *      UI 模型选择器（/model 弹窗与输入框模型位）出现本目录的模型分组；
 *   2. `listModels()` 公布 codebuddy CLI `--model` 官方支持的模型清单；
 *   3. `resolveModel()` 放行任意模型 id（含控制台自定义 ID），选择经
 *      session.selectModel 校验后落为 `model/selection` 会话事件；
 *   4. `stream()` 故意不可用——真实对话由 buddy-loop（CodeBuddy SDK）驱动，
 *      本适配器只承担"目录 + 校验"职责，永不承载流式调用。
 *
 * 鉴权说明：CodeBuddy 走 CLI 登录态（腾讯积分），不需要 API 密钥，
 * 配置留空即可。本插件不产生任何网络请求。
 */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';

const PROVIDER = 'codebuddy';

/** codebuddy CLI `--model` 官方支持清单（`codebuddy --help`，2026-09 实测）。 */
const MODEL_CATALOG = [
    { id: 'fast-model', name: 'Fast（快速）', description: '轻量快速，适合简单任务' },
    { id: 'balanced-model', name: 'Balanced（均衡）', description: '速度与能力均衡的默认档' },
    { id: 'deep-model', name: 'Deep（深度）', description: '深度推理，适合复杂任务' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'glm-5.1', name: 'GLM-5.1' },
    { id: 'glm-5v-turbo', name: 'GLM-5V-Turbo' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
    { id: 'kimi-k3-1', name: 'Kimi-K3.1' },
    { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview' },
    { id: 'kimi-k2.7', name: 'Kimi-K2.7' },
    { id: 'kimi-k2.6', name: 'Kimi-K2.6' },
    { id: 'minimax-m3', name: 'MiniMax-M3' },
    { id: 'hy4-preview', name: 'HY4-Preview' },
    { id: 'hy4-preview-f', name: 'HY4-Preview-F' },
    { id: 'hy3', name: 'HY3' },
    { id: 'hy3-x', name: 'HY3-X' },
];

/**
 * CodeBuddy 目录适配器：只回答"有哪些模型 / 这个模型身份是否可用"，
 * 永不真正发流。任何未被目录收录的模型 id 也放行——控制台支持自定义 ID，
 * 目录成员资格只是建议性的（catalog membership is advisory）。
 */
class CodeBuddyLlmAdapter extends LlmAdapter {
    async *stream() {
        throw new LlmError(
            'codebuddy 路由由 buddy-loop（CodeBuddy SDK）直接驱动；本适配器只提供模型目录与选择校验，不承载流式调用。',
            'CODEBUDDY_SDK_DRIVEN',
        );
    }

    /** 向选择器公布模型目录（selector catalog membership is advisory）。 */
    async listModels() {
        return MODEL_CATALOG.map((model) => ({
            provider: PROVIDER,
            id: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            inputModalities: ['text'],
        }));
    }

    /** 一次查询内解析确切的提供方/模型身份；目录外 ID 同样放行。 */
    async resolveModel(provider, model) {
        return { provider, model };
    }
}

export const name = 'buddy-llm-codebuddy';
export const inject = ['llm'];

export const Config = z.object({});

export function apply(ctx) {
    ctx.effect(
        () => ctx.llm.registerAdapter([PROVIDER], new CodeBuddyLlmAdapter()),
        'buddyLlmCodebuddy.registerAdapter(codebuddy)',
    );
}
