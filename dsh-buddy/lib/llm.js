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
import { getModelCatalog, setCatalogCliPath } from './catalog.js';

const PROVIDER = 'codebuddy';

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

    /** 向选择器公布模型目录（catalog membership is advisory；目录可被 CLI 刷新动态更新）。 */
    async listModels() {
        return getModelCatalog().map((model) => ({
            provider: PROVIDER,
            id: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            inputModalities: ['text'],
        }));
    }

    /**
     * 一次查询内解析确切的提供方/模型身份（LlmResolvedModelInfo 契约：
     * provider 必须等于路由名、id 必须等于请求的模型 ID、name 非空）。
     * 目录内返回目录元数据；目录外 ID 同样放行（name 回退为 ID 本身）。
     */
    async resolveModel(provider, model) {
        if (provider !== PROVIDER) {
            throw new LlmError(`unknown provider route "${provider}"`, 'UNKNOWN_PROVIDER');
        }
        const entry = getModelCatalog().find((item) => item.id === model);
        return {
            provider: PROVIDER,
            id: model,
            name: entry?.name ?? model,
            ...(entry?.description === undefined ? {} : { description: entry.description }),
            inputModalities: ['text'],
        };
    }
}

export const name = 'buddy-llm-codebuddy';
export const inject = ['llm'];

/**
 * 设置页命名空间 = 本插件在 profile patch 里的条目 id（cordis.patch.yml 中
 * `- id: buddy-llm-codebuddy`），rc.2 起 settings 服务按“配置条目 id”自动投影
 * 命名空间，无需再手工注册。
 */
const SETTINGS_NS = 'buddy-llm-codebuddy';

/**
 * 本条目的 Config。
 *
 * dsh 0.2.0 的设置页只渲染 Config 中标记 `.volatile()` 的字段（volatile 语义 =
 * 「热更不重启即可生效」，见 settings 包 volatileForm），且**空 schema 的命名空间
 * 会被整条跳过** —— 那正是换心后「模型」页只剩 DeepSeek 卡片的原因。所以这里给一个
 * 真实可用、且确实需要热更的字段：CodeBuddy CLI 可执行文件路径（默认走 PATH 解析，
 * 非默认安装位置时填绝对路径；改完刷新即生效，无需重启 dsh）。
 */
export const Config = z.object({
    cliPath: z.string().default('').volatile(),
});

export function apply(ctx, config) {
    // 把设置页的 CLI 路径喂给目录刷新（llm.js 与 buddy-loop 是两个独立 dsh 条目，
    // 各有 Config 命名空间；目录来源统一存在 catalog.js 里共享）。
    const cliPath = typeof config?.cliPath === 'string' ? config.cliPath : '';
    ctx.effect(() => {
        setCatalogCliPath(cliPath);
        return () => setCatalogCliPath('');
    }, 'buddyLlmCodebuddy.cliPath');

    ctx.effect(
        () => {
            ctx.llm.registerAdapter([PROVIDER], new CodeBuddyLlmAdapter());
            // 可配置目录声明：设置页「模型」由此渲染 CodeBuddy 卡片
            // （ModelsSection 把目录与“活的命名空间视图”join，行才会出现）。
            ctx.llm.registerConfigurableProviders([
                { provider: PROVIDER, displayName: 'CodeBuddy', settingsNs: SETTINGS_NS, settingsPath: [] },
            ]);
        },
        'buddyLlmCodebuddy.registerAdapter(codebuddy)',
    );
    // dsh 0.2.0 起 settings 服务不再提供 installSection：命名空间由“配置条目 id +
    // 插件 Config 中的 volatile 字段”自动投影（见 Config 上方注释），此处无需再注册。
}
