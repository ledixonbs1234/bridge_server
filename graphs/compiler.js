// bridge_server/graphs/compiler.js
import { GraphState } from './state.js';
import { validateSyntax } from '../skills/validators/syntax_validator.js';
import tracer from '../tracer.js';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

export class DeclarativeGraphCompiler {
    static compile(jsonConfig) {
        // KIỂM DUYỆT AN TOÀN: Đảm bảo nút gốc ban đầu luôn tồn tại trong danh sách định nghĩa
        if (!jsonConfig.initial_node || !jsonConfig.nodes || !jsonConfig.nodes[jsonConfig.initial_node]) {
            throw new Error(`[Compiler Error] initial_node "${jsonConfig.initial_node}" không tồn tại trong danh sách cấu hình nodes.`);
        }

        const compiledNodes = new Map();
        const edges = new Map();

        // 1. Biên dịch các Nodes
        for (const [nodeName, nodeConfig] of Object.entries(jsonConfig.nodes)) {

            if (nodeConfig.type === 'agent') {
                // Biến đổi cấu hình Agent trong JSON thành một Node chạy LLM thực tế
                compiledNodes.set(nodeName, async (state, ctx) => {
                    const dynamicPrompt = state.renderPrompt(nodeConfig.system_prompt);

                    // Lọc ra các kỹ năng (Tools) được gán phép cho Agent này trong tệp JSON
                    const allowedSkills = {};
                    (nodeConfig.tools || []).forEach(toolName => {
                        if (ctx.skillRegistry[toolName]) {
                            allowedSkills[toolName] = ctx.skillRegistry[toolName];
                        }
                    });

                    console.log(chalk.cyan(`[Node Exec] 🤖 Spawning Declarative Agent Node: [${nodeName}]`));

                    // Thiết lập System Prompt dựa trên cấu hình bật/tắt kế thừa toàn cục
                    let systemPromptStr = `Bạn là thành viên trong đồ thị trạng thái đang thực thi node: ${nodeName}.`;
                    if (nodeConfig.include_global_prompt !== false) {
                        const promptPath = path.resolve(process.cwd(), 'system_prompt.md');
                        let globalPrompt = "";
                        if (fs.existsSync(promptPath)) {
                            globalPrompt = fs.readFileSync(promptPath, 'utf8');
                        }
                        const activeWS = globalThis.activeWorkspace || process.cwd().replace(/\\/g, '/');
                        const systemContext = `[TỰ ĐỘNG CUNG CẤP NGỮ CẢNH HỆ THỐNG]
- OS Platform: ${process.platform}
- OS Arch: ${process.arch}
- Current Working Directory (Thư mục hiện hành tuyệt đối): ${activeWS}

`;
                        systemPromptStr = `${systemPromptStr}\n\n${systemContext}${globalPrompt}`;
                    }

                    const response = await ctx.provider.chat({
                        messages: [{ role: 'user', content: dynamicPrompt }],
                        mode: nodeConfig.model_mode || 'fast',
                        skillRegistry: allowedSkills,
                        executeSkill: ctx.executeSkillFn,
                        systemPrompt: systemPromptStr,
                        maxSteps: 10,
                        isWorker: true,
                        workerType: nodeName
                    });

                    const cleanResponse = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

                    return {
                        last_output: cleanResponse,
                        next_node: nodeConfig.next || null
                    };
                });
            }

            else if (nodeConfig.type === 'validator') {
                // Biến đổi cấu hình kiểm duyệt thành Node kiểm thử
                compiledNodes.set(nodeName, async (state, ctx) => {
                    const targetFile = state.store[nodeConfig.target_file_key] || 'index.ts';

                    // Giải quyết đường dẫn tuyệt đối chính xác để đọc từ đĩa cứng
                    const absolutePath = path.isAbsolute(targetFile)
                        ? targetFile
                        : path.resolve(globalThis.activeWorkspace || process.cwd(), targetFile);

                    let codeToValidate = '';
                    if (fs.existsSync(absolutePath)) {
                        // Ưu tiên đọc trực tiếp từ file trên đĩa cứng để tránh lời thoại thừa của AI
                        codeToValidate = fs.readFileSync(absolutePath, 'utf8');
                    } else {
                        // Fallback về bộ nhớ tạm thời nếu file chưa được tạo ra
                        codeToValidate = state.store.pending_code || state.store.last_output || '';
                    }

                    console.log(chalk.cyan(`[Node Exec] 🛡️ Running Declarative Validator Node: [${nodeName}]`));
                    const syntaxResult = await validateSyntax(targetFile, codeToValidate);

                    if (!syntaxResult.valid) {
                        return {
                            errors: [syntaxResult.error],
                            retry_count: (state.store.retry_count || 0) + 1,
                            next_node: nodeConfig.next_on_failure
                        };
                    }

                    return {
                        errors: [],
                        next_node: nodeConfig.next_on_success
                    };
                });
            }
        }

        // 2. Biên dịch các rẽ nhánh Edges
        // Đọc cấu hình rẽ nhánh tĩnh
        (jsonConfig.edges || []).forEach(edge => {
            edges.set(edge.from, edge.to);
        });

        // Đọc cấu hình rẽ nhánh động (Conditional Edges)
        (jsonConfig.conditional_edges || []).forEach(cEdge => {
            if (cEdge.condition_type === 'state_check') {
                edges.set(cEdge.from, (stateStore) => {
                    const val = stateStore[cEdge.state_key];
                    const isNotEmpty = Array.isArray(val) ? val.length > 0 : !!val;

                    if (isNotEmpty) {
                        return cEdge.router.is_not_empty;
                    }
                    return cEdge.router.is_empty;
                });
            }
        });

        return {
            initialNode: jsonConfig.initial_node,
            nodes: compiledNodes,
            edges: edges,
            stateSchema: jsonConfig.state_schema
        };
    }
}