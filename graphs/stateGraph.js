// bridge_server/graphs/stateGraph.js
import { GraphState } from './state.js';

export class StateGraph {
    /**
     * Khởi tạo đồ thị với định nghĩa các kênh trạng thái (State Channels) và hàm Reducer
     * @param {Object} stateDefinition - Ví dụ: { messages: { default: [], reducer: (a, b) => a.concat(b) } }
     */
    constructor(stateDefinition = {}) {
        this.stateDefinition = stateDefinition;
        this.nodes = new Map();
        this.edges = new Map();
        this.initialNode = null;
    }

    /**
     * Đăng ký một Node xử lý bảo toàn State cô lập
     */
    addNode(name, nodeFn) {
        this.nodes.set(name, nodeFn);
        return this;
    }

    /**
     * Khai báo cạnh tuần tự
     */
    addEdge(from, to) {
        this.edges.set(from, to);
        return this;
    }

    /**
     * Khai báo cạnh có điều kiện
     */
    addConditionalEdge(from, conditionFn) {
        this.edges.set(from, conditionFn);
        return this;
    }

    /**
     * Đặt điểm khởi chạy FSM
     */
    setEntryPoint(name) {
        this.initialNode = name;
        return this;
    }

    /**
     * Biên dịch đồ thị
     */
    compile() {
        if (!this.initialNode) {
            throw new Error("StateGraph compiled without an entry point. Call setEntryPoint().");
        }

        const compiledNodes = new Map();

        // Đóng gói các node xử lý của người dùng với cơ chế Reducer
        for (const [nodeName, nodeFn] of this.nodes.entries()) {
            compiledNodes.set(nodeName, async (stateInstance, context) => {
                // Tạo một bản sao sâu (Deep Clone) của State hiện tại truyền cho Node để tránh can thiệp trực tiếp
                const stateSnapshot = JSON.parse(JSON.stringify(stateInstance.store));

                // Thực thi tác vụ bất đồng bộ tại Node
                const update = await nodeFn(stateSnapshot, context);

                // Áp dụng Reducer để hợp nhất kết quả cập nhật vào State chung
                const reducedUpdate = {};
                for (const [key, value] of Object.entries(update)) {
                    const channel = this.stateDefinition[key];
                    if (channel && typeof channel.reducer === 'function') {
                        reducedUpdate[key] = channel.reducer(stateInstance.store[key], value);
                    } else {
                        // Mặc định: Ghi đè trực tiếp giá trị mới
                        reducedUpdate[key] = value;
                    }
                }

                return reducedUpdate;
            });
        }

        // Tạo State Schema ban đầu từ giá trị mặc định của Definition
        const stateSchema = {};
        for (const [key, channel] of Object.entries(this.stateDefinition)) {
            stateSchema[key] = typeof channel.default === 'function'
                ? channel.default()
                : channel.default;
        }

        return {
            initialNode: this.initialNode,
            nodes: compiledNodes,
            edges: this.edges,
            stateSchema
        };
    }
}