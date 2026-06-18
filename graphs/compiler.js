// bridge_server/graphs/compiler.js
import { GraphState } from './state.js';
import { validateSyntax } from '../skills/validators/syntax_validator.js';
import tracer from '../tracer.js';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

export class DeclarativeGraphCompiler {
    static compile(jsonConfig) {
        if (!jsonConfig.initial_node || !jsonConfig.nodes || !jsonConfig.nodes[jsonConfig.initial_node]) {
            throw new Error(`[Compiler Error] initial_node "${jsonConfig.initial_node}" không tồn tại trong danh sách cấu hình nodes.`);
        }

        const compiledNodes = new Map();
        const edges = new Map();

        // 1. Biên dịch các Nodes
        for (const [nodeName, nodeConfig] of Object.entries(jsonConfig.nodes)) {

            if (nodeConfig.type === 'agent') {
                compiledNodes.set(nodeName, async (state, ctx) => {
                    const dynamicPrompt = state.renderPrompt(nodeConfig.system_prompt);
                    const allowedSkills = {};

                    (nodeConfig.tools || []).forEach(toolName => {
                        if (ctx.skillRegistry[toolName]) allowedSkills[toolName] = ctx.skillRegistry[toolName];
                    });

                    console.log(chalk.cyan(`[Node Exec] 🤖 Spawning Declarative Agent Node: [${nodeName}]`));

                    let systemPromptStr = `Bạn là thành viên trong đồ thị trạng thái đang thực thi node: ${nodeName}.`;
                    if (nodeConfig.include_global_prompt !== false) {
                        const promptPath = path.resolve(process.cwd(), 'system_prompt.md');
                        let globalPrompt = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : "";
                        const activeWS = globalThis.activeWorkspace || process.cwd().replace(/\\/g, '/');
                        systemPromptStr = `${systemPromptStr}\n\n[TỰ ĐỘNG CUNG CẤP NGỮ CẢNH HỆ THỐNG]\n- OS: ${process.platform}\n- CWD: ${activeWS}\n\n${globalPrompt}`;
                    }

                    const response = await ctx.provider.chat({
                        messages: [{ role: 'user', content: dynamicPrompt }],
                        mode: nodeConfig.model_mode || 'fast',
                        skillRegistry: allowedSkills,
                        executeSkill: ctx.executeSkillFn,
                        systemPrompt: systemPromptStr,
                        maxSteps: 15,
                        isWorker: true,
                        workerType: nodeName
                    });

                    const cleanResponse = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

                    // TRÍCH XUẤT STATE TỪ AGENT (Nâng cấp hỗ trợ Test Agent tự đánh dấu lỗi)
                    let stateUpdate = {
                        last_output: cleanResponse,
                        next_node: nodeConfig.next || null
                    };

                    const jsonStateMatch = cleanResponse.match(/```json\s*(\{[\s\S]*?(?:\"errors\"|\"next_node\")[\s\S]*?\})\s*```/i);
                    if (jsonStateMatch) {
                        try {
                            const parsedState = JSON.parse(jsonStateMatch[1]);
                            if (parsedState.errors !== undefined) stateUpdate.errors = parsedState.errors;
                            if (parsedState.next_node !== undefined) stateUpdate.next_node = parsedState.next_node;
                            console.log(chalk.yellow(`[Node Exec] ⚡ Agent [${nodeName}] đã can thiệp thay đổi FSM State (Errors: ${parsedState.errors?.length || 0}).`));
                        } catch (e) {
                            console.warn(chalk.yellow(`[Compiler] Lỗi parse JSON state từ Agent ${nodeName}`));
                        }
                    }

                    return stateUpdate;
                });
            }

            else if (nodeConfig.type === 'validator') {
                compiledNodes.set(nodeName, async (state, ctx) => {
                    const targetFile = state.store[nodeConfig.target_file_key] || 'index.ts';
                    const absolutePath = path.isAbsolute(targetFile) ? targetFile : path.resolve(globalThis.activeWorkspace || process.cwd(), targetFile);

                    let codeToValidate = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : (state.store.pending_code || state.store.last_output || '');

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

        // 2. Biên dịch Edges
        (jsonConfig.edges || []).forEach(edge => edges.set(edge.from, edge.to));

        (jsonConfig.conditional_edges || []).forEach(cEdge => {
            if (cEdge.condition_type === 'state_check') {
                edges.set(cEdge.from, (stateStore) => {
                    const val = stateStore[cEdge.state_key];
                    const isNotEmpty = Array.isArray(val) ? val.length > 0 : !!val;
                    return isNotEmpty ? cEdge.router.is_not_empty : cEdge.router.is_empty;
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