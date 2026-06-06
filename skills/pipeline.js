import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../database.js';

// Fix lỗi __dirname trong ES Module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Helper: Tạo một Hợp đồng thực thi (Execution Contract) chuẩn hóa cho từng Step
 * Tách riêng giúp giảm mã nguồn lặp lại giữa create_pipeline_plan và load_harness_template.
 */
export function buildExecutionContract(step, artifactsDir) {
    return {
        step_key: step.step_key,
        task_description: step.task,
        target_tool: step.tool,
        parallel_group: step.parallel_group,
        dependencies: step.depends_on || [],
        budget: {
            max_retries: step.validation?.max_retries || 3,
            allocated_tokens: 8192
        },
        completion_criteria: step.validation || {
            type: "llm_check",
            value: `Verify ${step.task}`
        },
        output_artifact_path: path.join(artifactsDir, `${step.step_key}_artifact.json`).replace(/\\/g, '/')
    };
}

/**
 * Helper: Khởi tạo trạng thái mặc định cho các Stage và gán step_key an toàn
 */
export function initializePipelineStages(stages) {
    if (!stages || !Array.isArray(stages)) {
        throw new Error("Pipeline must have valid stages.");
    }
    stages.forEach((stage, sIdx) => {
        stage.status = "PENDING";

        if (!stage.steps || !Array.isArray(stage.steps) || stage.steps.length === 0) {
            throw new Error(`Giai đoạn "${stage.name}" bắt buộc phải có mảng "steps" chứa ít nhất một tác vụ cụ thể.`);
        }

        stage.steps.forEach((step, stIdx) => {
            step.status = "PENDING";
            step.step_key = `stage_${sIdx}.step_${stIdx}`;
            if (!step.parallel_group) step.parallel_group = null;
            if (!step.depends_on) step.depends_on = [];
        });
    });
}

/**
 * Handler dùng chung cho việc lập kế hoạch Pipeline từ tài liệu Spec
 */
async function pipelinePlanHandler(args) {
    if (!args.spec_approved) {
        throw new Error("Spec must be approved before execution.");
    }

    const specPath = path.isAbsolute(args.spec_file) ? args.spec_file : path.resolve(process.cwd(), args.spec_file);
    if (!fs.existsSync(specPath)) {
        throw new Error(`Spec file does not exist at path: ${args.spec_file}`);
    }

    const memoryDir = path.join(process.cwd(), '.agent_memory');
    if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

    const pipelineName = args.pipeline_name || args.plan_name || "Unnamed Pipeline";
    const stages = args.stages || [];

    initializePipelineStages(stages);

    // In ra Terminal giao diện CI/CD
    console.log(`\n\x1b[44m\x1b[37m 📋 AI ĐỀ XUẤT PIPELINE: ${pipelineName.toUpperCase()} \x1b[0m`);
    console.log(`\x1b[35mSpec File: ${args.spec_file}\x1b[0m`);
    stages.forEach((stage, sIdx) => {
        console.log(`\x1b[36mStage ${sIdx + 1}: ${stage.name}\x1b[0m`);
        stage.steps.forEach((step, stIdx) => {
            const parallelTag = step.parallel_group ? `\x1b[35m[⇄ ${step.parallel_group}]\x1b[0m ` : '';
            const depsTag = step.depends_on.length > 0 ? `\x1b[33m[← ${step.depends_on.join(', ')}]\x1b[0m ` : '';
            console.log(`   ├─ [ ] ${parallelTag}${depsTag}${step.task} (Tool: \x1b[33m${step.tool}\x1b[0m)`);
        });
    });

    // Lưu kế hoạch vào SQLite
    const stmt = db.prepare(`INSERT OR REPLACE INTO pipelines (id, name, status, data) VALUES (?, ?, ?, ?)`);
    stmt.run('CURRENT', pipelineName, 'IN_PROGRESS', JSON.stringify({ ...args, pipeline_name: pipelineName, stages }));

    // Khởi tạo File-Backed State
    const stateDir = path.join(memoryDir, 'state');
    const contractsDir = path.join(stateDir, 'contracts');
    const artifactsDir = path.join(stateDir, 'artifacts');

    if (!fs.existsSync(contractsDir)) fs.mkdirSync(contractsDir, { recursive: true });
    if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });

    // Khởi tạo agent_states & Hợp đồng thực thi (Execution Contracts)
    const stateStmt = db.prepare(`INSERT OR REPLACE INTO agent_states (pipeline_id, step_key, state, retry_count, error_history, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
    const now = new Date().toISOString();

    for (const stage of stages) {
        for (const step of stage.steps) {
            stateStmt.run('CURRENT', step.step_key, 'PENDING', 0, '[]', now);

            // Xây dựng hợp đồng thực thi thông qua Builder Helper
            const contract = buildExecutionContract(step, artifactsDir);

            fs.writeFileSync(
                path.join(contractsDir, `${step.step_key}.json`),
                JSON.stringify(contract, null, 2),
                'utf8'
            );
        }
    }

    return {
        status: "success",
        message: `Pipeline đã được tạo tự động từ Spec file: ${args.spec_file}. Hệ thống đã khởi tạo các Hợp đồng thực thi (Execution Contracts) tại thư mục '.agent_memory/state/contracts/'. Hãy thực thi Stage 1 ngay.`
    };
}

export default {
    "create_pipeline_plan": {
        description: "[QUAN TRỌNG] Thực thi một Spec đã được phê duyệt.\n\n" +
            "Tiền điều kiện:\n" +
            "- workflow_brainstorming đã hoàn thành\n" +
            "- spec đã được duyệt\n\n" +
            "Pipeline KHÔNG được phép:\n" +
            "- hỏi requirement\n" +
            "- thiết kế kiến trúc\n" +
            "- tạo spec mới\n\n" +
            "Pipeline chỉ được:\n" +
            "- phân rã spec thành execution tasks (PREPARE, IMPLEMENT, VALIDATE, VERIFY)\n" +
            "- tạo execution contracts\n" +
            "- thực thi\n" +
            "- validate\n" +
            "- verify",
        parameters: {
            type: "object",
            properties: {
                spec_file: { type: "string", description: "Đường dẫn tuyệt đối hoặc tương đối đến file spec đã được phê duyệt (ví dụ: docs/superpowers/specs/2026-06-05-auth-design.md)." },
                spec_approved: { type: "boolean", description: "Xác nhận spec này đã được người dùng phê duyệt chưa (bắt buộc phải là true)." },
                pipeline_name: { type: "string", description: "Tên của pipeline (VD: Xây dựng tính năng Auth)" },
                plan_name: { type: "string", description: "Tên thay thế dự phòng của pipeline (VD: Xây dựng tính năng Auth)" },
                stages: {
                    type: "array",
                    description: "Danh sách các giai đoạn cần làm.",
                    items: {
                        type: "object",
                        properties: {
                            name: { type: "string", description: "Tên stage (VD: Nghiên cứu, Code Backend, Test)" },
                            steps: {
                                type: "array",
                                description: "Các bước nhỏ trong stage này",
                                items: {
                                    type: "object",
                                    properties: {
                                        task: {
                                            type: "string",
                                            description: "Mô tả công việc (BẮT BUỘC: Nếu công việc liên quan đến file/terminal, phải ghi rõ ĐƯỜNG DẪN THƯ MỤC TUYỆT ĐỐI. VD: 'Khởi tạo npm tại C:/Users/Xon/Desktop/test')"
                                        },
                                        tool: { type: "string", description: "Tên skill dự kiến sử dụng (VD: read_file, execute_terminal_command)" },
                                        parallel_group: {
                                            type: "string",
                                            description: "Tên nhóm song song. Các step có cùng parallel_group trong một Stage sẽ được chạy ĐỒNG THỜI bằng Promise.allSettled. Để trống nếu step cần chạy tuần tự."
                                        },
                                        depends_on: {
                                            type: "array",
                                            items: { type: "string" },
                                            description: "Danh sách step_key (VD: 'stage_0.step_0') mà step này phụ thuộc vào. Step chỉ chạy khi TẤT CẢ dependencies đã DONE. Để trống nếu không có phụ thuộc."
                                        },
                                        validation: {
                                            type: "object",
                                            description: "Phương thức kiểm tra kết quả bước này (Không bắt buộc, động cơ tự suy luận nếu để trống)",
                                            properties: {
                                                type: { type: "string", enum: ["command", "file_exists", "llm_check"], description: "Loại validation: chạy lệnh terminal, kiểm tra file tồn tại, hoặc dùng LLM tự kiểm tra." },
                                                value: { type: "string", description: "Lệnh chạy, đường dẫn file, hoặc prompt mô tả tiêu chí kiểm tra cho LLM." },
                                                max_retries: { type: "number", description: "Số lần thử lại tối đa cho step này (mặc định: 3)" }
                                            },
                                            required: ["type", "value"]
                                        }
                                    },
                                    required: ["task", "tool"]
                                }
                            }
                        },
                        required: ["name", "steps"]
                    }
                }
            },
            required: ["spec_file", "spec_approved", "stages"]
        },
        handler: async (args) => {
            return await pipelinePlanHandler(args);
        }
    },
    "create_pipeline_plan_from_spec": {
        description: "[QUAN TRỌNG] Tạo và lập kế hoạch Pipeline từ một tài liệu Spec thiết kế đã được phê duyệt.\n\n" +
            "Tiền điều kiện:\n" +
            "- spec_file tồn tại\n" +
            "- spec_approved phải là true\n\n" +
            "Mục tiêu:\n" +
            "- Chuyển hóa thiết kế/spec thành các Giai đoạn thực thi cụ thể (PREPARE, IMPLEMENT, VALIDATE, VERIFY)\n" +
            "- Tự động tạo ra các Hợp đồng thực thi (Execution Contracts) cho Workflow Engine chạy tự động.",
        parameters: {
            type: "object",
            properties: {
                spec_file: { type: "string", description: "Đường dẫn tuyệt đối hoặc tương đối đến file spec thiết kế đã được phê duyệt (ví dụ: docs/superpowers/specs/2026-06-05-auth-design.md)." },
                spec_approved: { type: "boolean", description: "Xác nhận spec này đã được người dùng phê duyệt chưa (bắt buộc phải là true)." },
                pipeline_name: { type: "string", description: "Tên của pipeline (VD: Implement Auth)" },
                stages: {
                    type: "array",
                    description: "Danh sách các giai đoạn thực thi chi tiết.",
                    items: {
                        type: "object",
                        properties: {
                            name: { type: "string", description: "Tên giai đoạn (VD: Prepare, Implementation, Verification)" },
                            steps: {
                                type: "array",
                                description: "Các bước nhỏ trong giai đoạn này",
                                items: {
                                    type: "object",
                                    properties: {
                                        task: { type: "string", description: "Mô tả cụ thể tác vụ, bao gồm đường dẫn và lệnh nếu cần." },
                                        tool: { type: "string", description: "Tên skill dự kiến sử dụng." },
                                        parallel_group: { type: "string", description: "Tên nhóm song song (nếu có)." },
                                        depends_on: { type: "array", items: { type: "string" }, description: "Mảng step_key phụ thuộc." },
                                        validation: {
                                            type: "object",
                                            properties: {
                                                type: { type: "string", enum: ["command", "file_exists", "llm_check"] },
                                                value: { type: "string" },
                                                max_retries: { type: "number" }
                                            },
                                            required: ["type", "value"]
                                        }
                                    },
                                    required: ["task", "tool"]
                                }
                            }
                        },
                        required: ["name", "steps"]
                    }
                }
            },
            required: ["spec_file", "spec_approved", "stages"]
        },
        handler: async (args) => {
            return await pipelinePlanHandler(args);
        }
    },
    "load_harness_template": {
        description: "[NLAH] Nạp một Hợp đồng thực thi mẫu (Harness Template) đã được tối ưu hóa từ trước cho một nhóm tác vụ cụ thể (VD: react_setup, bug_fixing). Dùng công cụ này giúp bỏ qua bước lập kế hoạch động để tiết kiệm Token và đảm bảo tính tuần tự chính xác.",
        parameters: {
            type: "object",
            properties: {
                template_name: {
                    type: "string",
                    description: "Tên của file cấu hình harness nằm trong thư mục harnesses (VD: react_setup.json)"
                }
            },
            required: ["template_name"]
        },
        handler: async (args) => {
            const memoryDir = path.join(process.cwd(), '.agent_memory');
            const harnessesDir = path.join(memoryDir, 'harnesses');

            if (!fs.existsSync(harnessesDir)) {
                fs.mkdirSync(harnessesDir, { recursive: true });
            }

            const templatePath = path.join(harnessesDir, args.template_name.endsWith('.json') ? args.template_name : `${args.template_name}.json`);

            if (!fs.existsSync(templatePath)) {
                const sampleTemplate = {
                    pipeline_name: "Khởi tạo dự án React chuẩn hóa",
                    stages: [
                        {
                            name: "Khởi tạo môi trường",
                            steps: [
                                {
                                    task: "Khởi tạo dự án React bằng Vite tại thư mục hiện hành",
                                    tool: "execute_terminal_command",
                                    validation: {
                                        type: "file_exists",
                                        value: "package.json",
                                        max_retries: 2
                                    }
                                }
                            ]
                        },
                        {
                            name: "Cài đặt & Xác thực",
                            steps: [
                                {
                                    task: "Cài đặt dependencies và chạy thử build kiểm tra lỗi biên dịch",
                                    tool: "execute_terminal_command",
                                    validation: {
                                        type: "command",
                                        value: "npm run build",
                                        max_retries: 3
                                    }
                                }
                            ]
                        }
                    ]
                };
                fs.writeFileSync(templatePath, JSON.stringify(sampleTemplate, null, 2), 'utf8');
                throw new Error(`Template không tồn tại. Hệ thống đã tạo một file mẫu tại: ${templatePath.replace(/\\/g, '/')}. Hãy hiệu chỉnh file này và gọi lại lệnh.`);
            }

            const templateData = JSON.parse(fs.readFileSync(templatePath, 'utf8'));

            // Gán step_key và trạng thái PENDING sử dụng helper
            initializePipelineStages(templateData.stages);

            const stateDir = path.join(memoryDir, 'state');
            const contractsDir = path.join(stateDir, 'contracts');
            const artifactsDir = path.join(stateDir, 'artifacts');
            if (!fs.existsSync(contractsDir)) fs.mkdirSync(contractsDir, { recursive: true });
            if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });

            const stmt = db.prepare(`INSERT OR REPLACE INTO pipelines (id, name, status, data) VALUES (?, ?, ?, ?)`);
            stmt.run('CURRENT', templateData.pipeline_name, 'IN_PROGRESS', JSON.stringify(templateData));

            const stateStmt = db.prepare(`INSERT OR REPLACE INTO agent_states (pipeline_id, step_key, state, retry_count, error_history, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
            const now = new Date().toISOString();

            for (const stage of templateData.stages) {
                for (const step of stage.steps) {
                    stateStmt.run('CURRENT', step.step_key, 'PENDING', 0, '[]', now);

                    // Xây dựng hợp đồng qua helper
                    const contract = buildExecutionContract(step, artifactsDir);

                    fs.writeFileSync(
                        path.join(contractsDir, `${step.step_key}.json`),
                        JSON.stringify(contract, null, 2),
                        'utf8'
                    );
                }
            }

            console.log(`\n[NLAH] 📂 Đã nạp thành công Harness Template: "${templateData.pipeline_name}"`);
            return {
                status: "success",
                message: `Đã nạp thành công Harness Template: "${templateData.pipeline_name}". Toàn bộ Hợp đồng thực thi đã được ghi nhận. Hệ thống đã sẵn sàng bàn giao cho workflow_engine.`
            };
        }
    }
};