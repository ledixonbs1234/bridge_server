// bridge_server/graphs/state.js

export class GraphState {
    constructor(schema = {}) {
        this.store = {
            messages: [],
            last_output: "",
            errors: [],
            retry_count: 0,
            ...schema
        };
    }

    update(newData) {
        for (const [key, value] of Object.entries(newData)) {
            if (key === 'messages' && Array.isArray(value)) {
                this.store.messages = [...this.store.messages, ...value];
            } else {
                this.store[key] = value;
            }
        }
    }

    // Cơ chế biên dịch nóng (interpolate) biến trạng thái vào Prompt của Agent
    renderPrompt(templateString) {
        return templateString.replace(/\${state\.(\w+)}/g, (match, key) => {
            const val = this.store[key];
            if (Array.isArray(val)) return JSON.stringify(val);
            return val !== undefined ? String(val) : '';
        });
    }
}