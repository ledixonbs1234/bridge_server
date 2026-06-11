// bridge_server/graphs/workflows/docGeneratorWorkflow.js
import { StateGraph } from '../stateGraph.js';
import fs from 'fs';
import path from 'path';

// 1. ĐỊNH NGHĨA STATE CHANNELS & REDUCERS (Kiểu LangGraph)
const docStateDefinition = {
    task: { default: "", reducer: (current, update) => update },
    target_dir: { default: "", reducer: (current, update) => update },
    code_signatures: { default: () => [], reducer: (current, update) => current.concat(update) },
    draft_markdown: { default: "", reducer: (current, update) => update },
    feedback: { default: "", reducer: (current, update) => update },
    retry_count: { default: 0, reducer: (current, update) => update },
    errors: { default: () => [], reducer: (current, update) => update } // Overwrite errors mỗi vòng [5]
};

// 2. KHỞI TẠO CÁC NODES XỬ LÝ (Plain JavaScript async functions)

/**
 * Node 1: Quét cấu trúc thư mục dự án và trích xuất thông tin chữ ký hàm (Signatures)
 */
async function codeInspectorNode(state, context) {
    const targetDir = state.target_dir || globalThis.activeWorkspace || process.cwd();
    console.log(`\n[Doc Graph] 🔍 Node [codeInspectorNode] đang quét thư mục: ${targetDir}`);

    // Sử dụng skill có sẵn để lấy danh sách file một cách an toàn
    const listMarkdown = await context.executeSkillFn('list_directory', { path: targetDir, depth: 2 });

    const inspectPrompt = `Bạn là một Chuyên viên phân tích mã nguồn (Code Architect Analyst).
Dưới đây là cấu trúc tệp của thư mục mục tiêu:

${listMarkdown}

Nhiệm vụ của bạn:
1. Hãy tìm kiếm các file mã nguồn cốt lõi (ví dụ các file JS/TS xử lý logic chính).
2. Trả về cấu trúc mảng JSON các đường dẫn file tuyệt đối cần trích xuất API.
Ví dụ: ["C:/Project/server.js", "C:/Project/utils.js"]
Nếu không có file phù hợp, trả về mảng rỗng [].

Chỉ trả về định dạng mảng JSON thô, không viết lời dẫn.`;

    const response = await context.provider.chat({
        messages: [{ role: 'user', content: inspectPrompt }],
        systemPrompt: "Bạn là chuyên gia phân tích file. Chỉ trả về mảng JSON.",
        mode: "fast",
        isWorker: true,
        workerType: 'code_inspector'
    });

    const cleanRes = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    let code_signatures = [];
    try {
        code_signatures = JSON.parse(cleanRes);
    } catch {
        // Fallback thủ công nếu AI trả về chuỗi bọc markdown
        const match = cleanRes.match(/\[[\s\S]*?\]/);
        if (match) code_signatures = JSON.parse(match[0]);
    }

    return { code_signatures };
}

/**
 * Node 2: Đọc mã nguồn và biên soạn bản thảo tài liệu (Markdown API Draft)
 */
async function docDrafterNode(state, context) {
    const filesToRead = state.code_signatures.slice(0, 3); // Giới hạn đọc tối đa 3 file mẫu để tiết kiệm token
    console.log(`\n[Doc Graph] ✍️ Node [docDrafterNode] đang đọc và biên soạn tài liệu cho ${filesToRead.length} tệp...`);

    let sourceCodesCompiled = "";
    for (const f of filesToRead) {
        try {
            const fileContent = await context.executeSkillFn('read_file', { file_path: f });
            sourceCodesCompiled += `\n\n=== TỆP TIN: ${f} ===\n${fileContent}`;
        } catch (e) {
            console.warn(`[Doc Graph] Lỗi khi đọc file ${f}: ${e.message}`);
        }
    }

    const draftPrompt = `Bạn là Technical Writer chuyên nghiệp.
Dưới đây là mã nguồn hệ thống:
${sourceCodesCompiled}

Nhiệm vụ của bạn:
Biên soạn một tài liệu hướng dẫn kỹ thuật Markdown hoàn chỉnh mô tả cấu trúc, các API chính, tham số yêu cầu và kiểu dữ liệu trả về của mã nguồn trên.
Sử dụng ngôn ngữ tiếng Việt khoa học, rõ ràng.`;

    const draft = await context.provider.chat({
        messages: [{ role: 'user', content: draftPrompt }],
        systemPrompt: "Bạn là chuyên viên viết tài liệu kỹ thuật chuẩn.",
        mode: "thinking", // Bật chế độ suy nghĩ sâu cho bản thảo chất lượng cao
        isWorker: true,
        workerType: 'doc_drafter'
    });

    return {
        draft_markdown: draft.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    };
}

/**
 * Node 3: Soát lỗi tài liệu (Proofreader) và đưa ra phản hồi cải tiến
 */
async function proofreaderNode(state, context) {
    console.log(`\n[Doc Graph] 📝 Node [proofreaderNode] đang rà soát ngữ nghĩa và chính tả...`);

    const proofPrompt = `Bạn là Chuyên gia biên tập ngôn ngữ và tài liệu (Technical Proofreader).
Dưới đây là bản thảo tài liệu kỹ thuật:

${state.draft_markdown}

Nhiệm vụ của bạn:
1. Đọc và soát các lỗi: chính tả, hành văn lủng củng, định dạng bảng markdown bị vỡ, thiếu ví dụ minh họa hoặc thiếu API.
2. Đánh giá chất lượng tài liệu.
3. Trả về đúng định dạng cấu trúc JSON sau:
\`\`\`json
{
  "passed": false, 
  "feedback": "Tài liệu hành văn tốt nhưng bị vỡ định dạng bảng ở phần thông số API và thiếu ví dụ gọi mẫu..."
}
\`\`\`
Nếu tài liệu đã hoàn hảo, trả về "passed": true.
Chỉ trả về JSON thô không viết lời dẫn ngoài.`;

    const response = await context.provider.chat({
        messages: [{ role: 'user', content: proofPrompt }],
        systemPrompt: "Bạn là chuyên gia rà soát chất lượng tài liệu. Chỉ trả về JSON.",
        mode: "fast",
        isWorker: true,
        workerType: 'proofreader'
    });

    const cleanRes = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    let verdict = { passed: true, feedback: "" };
    try {
        verdict = JSON.parse(cleanRes);
    } catch {
        const match = cleanRes.match(/\{[\s\S]*?\}/);
        if (match) verdict = JSON.parse(match[0]);
    }

    if (!verdict.passed) {
        return {
            errors: [verdict.feedback],
            retry_count: state.retry_count + 1,
            feedback: verdict.feedback
        };
    }

    // Đã thông qua, ghi file tài liệu xuống đĩa cứng
    const outPath = path.join(globalThis.activeWorkspace || process.cwd(), 'API_DOCUMENTATION.md');
    await context.executeSkillFn('write_file', {
        file_path: outPath,
        content: state.draft_markdown
    });

    console.log(`\n[Doc Graph] 🎉 Hoàn thành! Tài liệu đã được ghi tại: ${outPath}`);
    return { errors: [] }; // Xóa rác lỗi nếu thành công [5]
}

// 3. THIẾT LẬP GRAPH TOPOLOGY & ROUTING
const graph = new StateGraph(docStateDefinition);

graph
    .addNode("inspector", codeInspectorNode)
    .addNode("drafter", docDrafterNode)
    .addNode("proofreader", proofreaderNode);

graph.setEntryPoint("inspector");

// Cạnh tuần tự
graph.addEdge("inspector", "drafter");
graph.addEdge("drafter", "proofreader");

// Cạnh rẽ nhánh điều kiện (Conditional Routing)
graph.addConditionalEdge("proofreader", (stateStore) => {
    // Nếu có lỗi soát chữ và chưa thử quá 2 lần -> Bắt drafter viết lại
    if (stateStore.errors && stateStore.errors.length > 0 && stateStore.retry_count < 2) {
        console.log(`[Doc Graph] ↩️ Lặp sửa đổi! Chuyển hướng về [drafter] để tối ưu theo phản hồi...`);
        return "drafter";
    }
    // Thành công hoặc quá giới hạn lặp -> Kết thúc FSM
    return "end";
});

export const docGeneratorWorkflow = graph.compile();