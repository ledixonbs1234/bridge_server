// bridge_server/workflow_engine.js
import { harnessRegistry } from './graphs/registry.js';
import { DeclarativeGraphRunner } from './graphs/runner.js';
import db from './database.js';
import path from 'path';

export default class WorkflowEngine {
    constructor(provider, skillRegistry, executeSkillFn, globalContext = "") {
        this.provider = provider;
        this.skillRegistry = skillRegistry;
        this.executeSkillFn = executeSkillFn;
        this.globalContext = globalContext;
    }

    async run() {
        const pipelineRow = db.prepare(`SELECT data FROM pipelines WHERE id = 'CURRENT'`).get();
        if (!pipelineRow || !pipelineRow.data) return;

        const pipeline = JSON.parse(pipelineRow.data);
        const harnessName = pipeline.harness_type || 'developer_workflow';

        const compiledGraph = harnessRegistry.getCompiledGraph(harnessName);

        const context = {
            provider: this.provider,
            skillRegistry: this.skillRegistry,
            executeSkillFn: this.executeSkillFn
        };

        const targetFile = pipeline.stages?.[0]?.steps?.[0]?.task?.match(/(?:[a-zA-Z]:\/|\/)[^\s"']+/)?.[0] || "index.ts";

        const initialState = {
            task: this.globalContext,
            target_file: targetFile,
            workspace: globalThis.activeWorkspace || process.cwd()
        };

        try {
            // Chạy đồ thị khai báo tự động
            await DeclarativeGraphRunner.run(compiledGraph, initialState, context);

            // Cập nhật trạng thái Pipeline thành công trong database
            pipeline.status = 'DONE';
            db.prepare(`UPDATE pipelines SET status = ?, data = ? WHERE id = 'CURRENT'`)
                .run('DONE', JSON.stringify(pipeline));
        } catch (err) {
            // Cập nhật trạng thái Pipeline thất bại khi có lỗi xảy ra
            pipeline.status = 'FAILED';
            db.prepare(`UPDATE pipelines SET status = ?, data = ? WHERE id = 'CURRENT'`)
                .run('FAILED', JSON.stringify(pipeline));
            throw err;
        }
    }
}