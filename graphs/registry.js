// bridge_server/graphs/registry.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DeclarativeGraphCompiler } from './compiler.js';
import chalk from 'chalk';
import { docGeneratorWorkflow } from './workflows/docGeneratorWorkflow.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const harnessesDir = path.join(__dirname, '..', 'harnesses');

class HarnessRegistry {
    constructor() {
        this.rawConfigs = new Map();
        this.compiledGraphs = new Map();
        this.init();
    }

    init() {
        if (!fs.existsSync(harnessesDir)) {
            fs.mkdirSync(harnessesDir, { recursive: true });
        }
        this.loadAllHarnesses();
        this.watchHarnessesDirectory();

        this.registerProgrammaticGraph("doc_generator", docGeneratorWorkflow, {
            harness_name: "doc_generator",
            description: "Multi-Agent sinh tài liệu API & Soát lỗi chính tả tự động",
            initial_node: "inspector",
            nodes: {
                "inspector": { "type": "agent", "tools": ["list_directory"] },
                "drafter": { "type": "agent", "tools": ["read_file"] },
                "proofreader": { "type": "validator", "tools": ["write_file"] }
            }
        });
    }


    loadAllHarnesses() {
        const files = fs.readdirSync(harnessesDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
            this.loadHarnessFile(file);
        }
    }

    loadHarnessFile(filename) {
        try {
            const filePath = path.join(harnessesDir, filename);
            const content = fs.readFileSync(filePath, 'utf8');
            const config = JSON.parse(content);

            // SỬA ĐỔI QUAN TRỌNG: Đồng bộ khóa ID sơ đồ tìm kiếm bám sát theo tên tệp vật lý (safe ID)
            const name = path.basename(filename, '.json');

            const compiled = DeclarativeGraphCompiler.compile(config);

            this.rawConfigs.set(name, config);
            this.compiledGraphs.set(name, compiled);

            console.log(chalk.green(`[Harness Registry] 🚀 Đã nạp và biên dịch nóng Harness: ${name}`));
        } catch (e) {
            console.error(chalk.red(`[Harness Registry] ❌ Lỗi biên dịch tệp ${filename}: ${e.message}`));
        }
    }

    getCompiledGraph(name) {
        return this.compiledGraphs.get(name) || this.compiledGraphs.get('developer_workflow');
    }

    getRawConfig(name) {
        return this.rawConfigs.get(name);
    }

    watchHarnessesDirectory() {
        fs.watch(harnessesDir, (eventType, filename) => {
            if (filename && filename.endsWith('.json')) {
                console.log(chalk.cyan(`[Harness Registry] 🔄 Phát hiện thay đổi trong tệp cấu hình: ${filename}. Đang nạp lại...`));
                this.loadHarnessFile(filename);
            }
        });
    }

    registerProgrammaticGraph(name, compiledGraph, rawConfig = null) {
        this.compiledGraphs.set(name, compiledGraph);
        if (rawConfig) {
            this.rawConfigs.set(name, rawConfig);
        } else {
            const nodes = {};
            for (const [nodeName] of compiledGraph.nodes.entries()) {
                const isValidator = nodeName.toLowerCase().includes('validator');
                nodes[nodeName] = {
                    type: isValidator ? 'validator' : 'agent',
                    tools: []
                };
            }
            this.rawConfigs.set(name, {
                harness_name: name,
                description: `Programmatic Graph Flow: ${name}`,
                initial_node: compiledGraph.initialNode,
                nodes
            });
        }
        console.log(chalk.green(`[Harness Registry] 🚀 Đã đồng bộ programmatic Graph: ${name}`));
    }
}

export const harnessRegistry = new HarnessRegistry();