import { query } from '@tencent-ai/agent-sdk';

console.log('[spike] 开始调用 CodeBuddy Agent SDK query()...');

const conversation = query({
    prompt: '请只回复一句话：buddy 大脑连接成功。不要执行任何工具操作，不要读任何文件。',
    options: {
        maxTurns: 2,
        allowedTools: [],
        stderr: (text) => process.stderr.write('[cli-stderr] ' + text),
    },
});

for await (const message of conversation) {
    if (message.type === 'assistant') {
        const content = message.message?.content ?? [];
        for (const c of content) {
            if (c.type === 'text' && c.text?.trim()) console.log('[assistant]', c.text.trim());
        }
    } else if (message.type === 'result') {
        console.log('[result]', JSON.stringify({
            subtype: message.subtype ?? null,
            duration_ms: message.duration_ms ?? null,
            is_error: message.is_error ?? null,
            usage: message.usage ?? null,
            result: (message.result ?? '').slice(0, 200),
        }, null, 2));
    } else {
        console.log('[event]', message.type);
    }
}

console.log('[spike] 结束');
