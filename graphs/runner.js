// bridge_server/graphs/runner.js
import { GraphState } from './state.js';
import db from '../database.js';
import chalk from 'chalk';

export class DeclarativeGraphRunner {
    static async run(graph, initialStateData, context) {
        const state = new GraphState(graph.stateSchema);
        state.update(initialStateData);

        let currentNodeName = graph.initialNode;

        while (currentNodeName) {
            const nodeFn = graph.nodes.get(currentNodeName);
            if (!nodeFn) break;

            // Chuyển dịch trạng thái FSM lên SQLite
            this.updateDatabaseState(currentNodeName, 'RUNNING');

            try {
                // Chạy node Agent/Validator khai báo
                const stateUpdate = await nodeFn(state, context);
                state.update(stateUpdate);

                this.updateDatabaseState(currentNodeName, 'DONE');

                // Lấy node kế tiếp
                const edgeTransition = graph.edges.get(currentNodeName);
                if (typeof edgeTransition === 'function') {
                    currentNodeName = await edgeTransition(state.store);
                } else if (typeof edgeTransition === 'string') {
                    currentNodeName = edgeTransition;
                } else {
                    currentNodeName = stateUpdate.next_node || null;
                }

            } catch (err) {
                this.updateDatabaseState(currentNodeName, 'FAILED', err.message);
                throw err;
            }
        }
    }

    static updateDatabaseState(nodeName, status, errorMsg = "") {
        try {
            db.prepare(`
                INSERT OR REPLACE INTO agent_states (pipeline_id, step_key, state, retry_count, error_history, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run('CURRENT', nodeName, status, 0, JSON.stringify(errorMsg ? [errorMsg] : []), new Date().toISOString());
        } catch (e) {
            console.warn(`[Graph Engine] Lỗi cập nhật SQLite: ${e.message}`);
        }
    }
}