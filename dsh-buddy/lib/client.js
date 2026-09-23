/**
 * dsh-buddy-loop client face — "电视附赠的遥控器" 浏览器 half。
 *
 * 加载链路（0.1.5-rc.3 官方机制，同 dsh-deep-whale 皮肤插件）：
 *   服务端 ClientModuleRegistry 扫描到本包 package.json 的 dsh.client 声明
 *   （platform:"web" + exports["./client"]）→ client bundle 组进
 *   window.__DSH_BOOT__ 图，经 /plugins/??dsh-buddy-loop/client.js 分发 →
 *   浏览器 boot 时 loader.create("dsh-buddy-loop") 拉取本文件，工厂物化后
 *   作为 cordis client 插件激活，经 ctx.slots 挂进设置页。
 *
 * 注意：本文件是经典脚本（<script src> 加载），顶层禁止 import/export；
 * react 等平台单例由宿主种子模块表经 require 注入。
 */
window.__ModuleLoader__.load({
    id: "dsh-buddy",
    factory: (require) => {
        const React = require("react");

        const ROUTE = "/api/buddy/config";
        const THINKING_OPTIONS = [
            { value: "", label: "默认（跟随 CLI 配置）" },
            { value: "adaptive", label: "自适应思考（adaptive）" },
            { value: "enabled", label: "固定预算（enabled）" },
            { value: "disabled", label: "关闭思考（disabled）" },
        ];

        const styles = {
            section: { display: "grid", gap: 12, maxWidth: 560 },
            row: { display: "grid", gap: 4 },
            label: { fontSize: 13, fontWeight: 500 },
            hint: { fontSize: 12, opacity: 0.65, lineHeight: 1.5 },
            input: {
                width: "100%", boxSizing: "border-box", font: "inherit",
                padding: "6px 8px", borderRadius: 8,
                border: "1px solid rgba(127,127,127,0.35)",
                background: "transparent", color: "inherit",
            },
            area: { resize: "vertical", fontFamily: "monospace" },
            footer: { display: "flex", alignItems: "center", gap: 10 },
            button: {
                font: "inherit", padding: "6px 16px", borderRadius: 8,
                border: "1px solid rgba(127,127,127,0.35)",
                background: "rgba(127,127,127,0.08)", color: "inherit", cursor: "pointer",
            },
            error: { fontSize: 12, color: "#d64545" },
        };

        /** env 对象 → 每行 KEY=VALUE 文本（编辑态）。 */
        function envToText(env) {
            if (!env || typeof env !== "object") return "";
            return Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n");
        }

        /** 每行 KEY=VALUE 文本 → env 对象；# 开头的行是注释。 */
        function textToEnv(text) {
            const env = {};
            for (const line of String(text || "").split(/\r?\n/)) {
                const trimmed = line.trim();
                if (trimmed === "" || trimmed.startsWith("#")) continue;
                const eq = trimmed.indexOf("=");
                if (eq <= 0) continue;
                const key = trimmed.slice(0, eq).trim();
                if (key) env[key] = trimmed.slice(eq + 1).trim();
            }
            return env;
        }

        /** 服务端配置 → 表单状态（与服务端 wire 形态解耦）。 */
        function hydrateForm(config) {
            return {
                model: typeof config.model === "string" ? config.model : "",
                maxTurns: typeof config.maxTurns === "number" ? String(config.maxTurns) : "",
                cwd: typeof config.cwd === "string" ? config.cwd : "",
                thinkingType: config.thinking && typeof config.thinking.type === "string" ? config.thinking.type : "",
                budgetTokens: config.thinking?.type === "enabled" && Number.isFinite(config.thinking.budgetTokens)
                    ? String(config.thinking.budgetTokens)
                    : "32000",
                envText: envToText(config.env),
                spMode: config.systemPrompt && typeof config.systemPrompt === "object" ? "append" : "override",
                spText: typeof config.systemPrompt === "string"
                    ? config.systemPrompt
                    : (config.systemPrompt?.append ?? ""),
            };
        }

        /** 表单状态 → 服务端 wire 载荷；空字段 = 移除该项覆盖。 */
        function buildPayload(form) {
            const payload = {};
            if (form.model.trim() !== "") payload.model = form.model.trim();
            const turns = Number(form.maxTurns);
            if (form.maxTurns.trim() !== "" && Number.isInteger(turns) && turns >= 1) payload.maxTurns = turns;
            if (form.cwd.trim() !== "") payload.cwd = form.cwd.trim();
            if (form.thinkingType !== "") {
                payload.thinking = form.thinkingType === "enabled"
                    ? { type: "enabled", budgetTokens: Number(form.budgetTokens) || 32000 }
                    : { type: form.thinkingType };
            }
            const env = textToEnv(form.envText);
            if (Object.keys(env).length > 0) payload.env = env;
            if (form.spText.trim() !== "") payload.systemPrompt = { mode: form.spMode, text: form.spText.trim() };
            return payload;
        }

        function BuddyRemotePanel() {
            const [form, setForm] = React.useState(null);
            const [status, setStatus] = React.useState({ kind: "loading", text: "正在加载配置…" });
            const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

            React.useEffect(() => {
                let alive = true;
                fetch(ROUTE)
                    .then((response) => response.json())
                    .then((body) => {
                        if (!alive) return;
                        if (!body.ok) throw new Error(body.error || "unknown");
                        setForm(hydrateForm(body.config ?? {}));
                        setStatus({ kind: "idle", text: "" });
                    })
                    .catch((error) => {
                        if (alive) setStatus({ kind: "error", text: "加载失败：" + (error?.message ?? error) });
                    });
                return () => { alive = false; };
            }, []);

            if (form === null) {
                return React.createElement("div", { style: styles.hint }, status.text);
            }

            const save = () => {
                setStatus({ kind: "busy", text: "保存中…" });
                fetch(ROUTE, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(buildPayload(form)),
                })
                    .then((response) => response.json())
                    .then((body) => {
                        if (!body.ok) throw new Error(body.error || "unknown");
                        setForm(hydrateForm(body.config ?? {}));
                        setStatus({ kind: "ok", text: "已保存 — 对新会话生效" });
                    })
                    .catch((error) => {
                        setStatus({ kind: "error", text: "保存失败：" + (error?.message ?? error) });
                    });
            };

            const input = (props) => React.createElement("input", { style: styles.input, ...props });
            const row = (label, hint, control) => React.createElement("label", { style: styles.row },
                React.createElement("span", { style: styles.label }, label),
                control,
                hint ? React.createElement("span", { style: styles.hint }, hint) : null);

            return React.createElement("div", { style: styles.section },
                React.createElement("p", { style: styles.hint },
                    "CodeBuddy 私有配置（dsh 自身设置不受影响）。保存后对新会话生效；清空字段即移除该项覆盖。"),
                row("模型 model", "留空 = CLI 默认", input({ value: form.model, onChange: set("model"), placeholder: "codebuddy" })),
                row("回合上限 maxTurns", "", input({ value: form.maxTurns, onChange: set("maxTurns"), inputMode: "numeric", placeholder: "30" })),
                row("思考模式 thinking", "", React.createElement("select", { style: styles.input, value: form.thinkingType, onChange: set("thinkingType") },
                    THINKING_OPTIONS.map((option) => React.createElement("option", { key: option.value, value: option.value }, option.label)))),
                form.thinkingType === "enabled"
                    ? row("思考预算 budgetTokens", "", input({ value: form.budgetTokens, onChange: set("budgetTokens"), inputMode: "numeric" }))
                    : null,
                row("工作目录 cwd", "CodeBuddy 执行命令的目录", input({ value: form.cwd, onChange: set("cwd"), placeholder: "E:\\projects\\demo" })),
                row("环境变量 env", "每行 KEY=VALUE，# 开头为注释", React.createElement("textarea", {
                    style: { ...styles.input, ...styles.area }, value: form.envText, onChange: set("envText"), rows: 3,
                })),
                row("系统提示词 systemPrompt", "", React.createElement("select", { style: styles.input, value: form.spMode, onChange: set("spMode") },
                    React.createElement("option", { value: "append" }, "追加到默认提示词（append）"),
                    React.createElement("option", { value: "override" }, "完全覆盖（override）"))),
                React.createElement("textarea", {
                    style: { ...styles.input, ...styles.area }, value: form.spText, onChange: set("spText"), rows: 4,
                    placeholder: "留给 CodeBuddy 的系统提示词…",
                }),
                React.createElement("div", { style: styles.footer },
                    React.createElement("button", { style: styles.button, onClick: save, disabled: status.kind === "busy" }, "保存配置"),
                    status.text !== "" ? React.createElement("span", { style: status.kind === "error" ? styles.error : styles.hint }, status.text) : null),
            );
        }

        /** cordis client 插件面：挂进设置页。 */
        function apply(ctx) {
            ctx.slots.inject("settings.section", () => ctx.slots.register({
                name: "settings.section",
                id: "dsh-buddy-config",
                order: 120,
                label: "CodeBuddy 遥控器",
            }, BuddyRemotePanel));
        }

        return { apply, inject: ["slots"] };
    },
});
