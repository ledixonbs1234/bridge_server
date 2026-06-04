import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../database.js';

// Fix lỗi __dirname trong ES Module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
    "create_pipeline_plan": {
        description: "[QUAN TRỌNG] Lập kế hoạch Pipeline theo mô hình Architect - Editor. BẮT BUỘC phải thực hiện đúng quy trình sau:\n" +
            "1. TRƯỚC KHI CHẠY LỆNH NÀY: Nếu tác vụ có tính sáng tạo (tạo tính năng mới, tạo component, sửa đổi hành vi), BẮT BUỘC phải gọi `workflow_brainstorming` trước để hiểu thấu đáo bối cảnh dự án, đề xuất các phương án giải quyết và lấy phê duyệt từ người dùng.\n" +
            "2. THIẾT KẾ PIPELINE: Chia nhỏ các Stage thành các bước nối tiếp:\n" +
            "   - ARCHITECT STEP (Khảo sát & Thiết kế): Khảo sát dự án đích và viết tài liệu thiết kế kĩ thuật chi tiết dạng tệp tin (ví dụ: 'spec_design.md').\n" +
            "   - EDITOR STEP (Biên tập & Kiểm thử): Lập trình chính xác dựa trên tài liệu thiết kế, sau đó tự chạy kiểm thử (compiler check).\n" +
            "   - VERIFICATION STEP (Chụp ảnh kiểm tra lỗi): BẮT BUỘC phải thêm bước chạy `capture_system_screenshot` (hoặc chụp màn hình trình duyệt) sau khi chạy ứng dụng/giao diện để tự động đối sánh, phân tích lỗi hiển thị trực quan, tránh phán đoán mù quáng.\n" +
            "Hỗ trợ chạy song song bằng parallel_group và tuần tự bằng depends_on.",
        parameters: {
            type: "object",
            properties: {
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
            required: ["stages"]
        },
        handler: async (args) => {
            const memoryDir = path.join(process.cwd(), '.agent_memory');
            const planFile = path.join(memoryDir, 'CURRENT_PIPELINE.json');

            if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

            const pipelineName = args.pipeline_name || args.plan_name || "Unnamed Pipeline";
            const stages = args.stages || [];

            if (stages.length === 0) {
                throw new Error("Pipeline phải có ít nhất một giai đoạn (stage) hợp lệ.");
            }

            // Khởi tạo trạng thái mặc định + gán step_key an toàn
            stages.forEach((stage, sIdx) => {
                stage.status = "PENDING";

                // Khắc phục lỗi: Đảm bảo stage.steps luôn tồn tại dưới dạng mảng để tránh crash
                if (!stage.steps || !Array.isArray(stage.steps) || stage.steps.length === 0) {
                    throw new Error(`Giai đoạn "${stage.name}" bắt buộc phải có mảng "steps" chứa nhất một tác vụ cụ thể.`);
                }

                stage.steps.forEach((step, stIdx) => {
                    step.status = "PENDING";
                    step.step_key = `stage_${sIdx}.step_${stIdx}`;
                    // Đảm bảo parallel_group và depends_on có giá trị mặc định
                    if (!step.parallel_group) step.parallel_group = null;
                    if (!step.depends_on) step.depends_on = [];
                });
            });

            // In ra Terminal giao diện đẹp mắt giống CI/CD
            console.log(`\n\x1b[44m\x1b[37m 📋 AI ĐỀ XUẤT PIPELINE: ${pipelineName.toUpperCase()} \x1b[0m`);
            stages.forEach((stage, sIdx) => {
                console.log(`\x1b[36mStage ${sIdx + 1}: ${stage.name}\x1b[0m`);
                stage.steps.forEach((step, stIdx) => {
                    const parallelTag = step.parallel_group ? `\x1b[35m[⇄ ${step.parallel_group}]\x1b[0m ` : '';
                    const depsTag = step.depends_on.length > 0 ? `\x1b[33m[← ${step.depends_on.join(', ')}]\x1b[0m ` : '';
                    console.log(`   ├─ [ ] ${parallelTag}${depsTag}${step.task} (Tool: \x1b[33m${step.tool}\x1b[0m)`);
                });
            });

            // Chờ User duyệt kế hoạch
            if (!global.isAutoApproveAll) {
                const answer = await global.askPermission(`\n👉 Bạn có duyệt kế hoạch Pipeline này không? [y: Yes / a: Yes to All / n: No] : `);
                if (answer === 'a') {
                    global.isAutoApproveAll = true;
                } else if (answer !== 'y') {
                    throw new Error("PERMISSION_DENIED: Người dùng đã từ chối kế hoạch này. Hãy hỏi họ xem cần điều chỉnh bước nào.");
                }
            }
            // Lưu kế hoạch vào bộ nhớ SQLite
            const stmt = db.prepare(`INSERT OR REPLACE INTO pipelines (id, name, status, data) VALUES (?, ?, ?, ?)`);
            stmt.run('CURRENT', pipelineName, 'IN_PROGRESS', JSON.stringify({ ...args, pipeline_name: pipelineName, stages }));

            // Khởi tạo cấu trúc lưu trữ File-Backed State
            const stateDir = path.join(memoryDir, 'state');
            const contractsDir = path.join(stateDir, 'contracts');
            const artifactsDir = path.join(stateDir, 'artifacts');

            if (!fs.existsSync(contractsDir)) fs.mkdirSync(contractsDir, { recursive: true });
            if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });

            // Khởi tạo agent_states cho mỗi step & Ghi File-Backed Contracts
            const stateStmt = db.prepare(`INSERT OR REPLACE INTO agent_states (pipeline_id, step_key, state, retry_count, error_history, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
            const now = new Date().toISOString();

            for (const stage of stages) {
                for (const step of stage.steps) {
                    stateStmt.run('CURRENT', step.step_key, 'PENDING', 0, '[]', now); // Truyền đủ 6 tham số

                    // Thiết lập Hợp đồng thực thi (Execution Contract) tĩnh cho Step
                    const contract = {
                        step_key: step.step_key,
                        task_description: step.task,
                        target_tool: step.tool,
                        parallel_group: step.parallel_group,
                        dependencies: step.depends_on || [],
                        budget: {
                            max_retries: step.validation?.max_retries || 3,
                            allocated_tokens: 8192 // Ngưỡng an toàn cho mô hình
                        },
                        completion_criteria: step.validation || {
                            type: "llm_check",
                            value: `Kiểm tra xem tác vụ "${step.task}" đã được hoàn thành đúng chưa.`
                        },
                        output_artifact_path: path.join(artifactsDir, `${step.step_key}_artifact.json`).replace(/\\/g, '/')
                    };

                    // Ghi hợp đồng ra file để Agent có thể tự đọc bằng kỹ năng của nó
                    fs.writeFileSync(
                        path.join(contractsDir, `${step.step_key}.json`),
                        JSON.stringify(contract, null, 2),
                        'utf8'
                    );
                }
            }

            return {
                status: "success",
                message: "Pipeline đã được người dùng PHÊ DUYỆT. Hệ thống đã khởi tạo các Hợp đồng thực thi (Execution Contracts) tại thư mục '.agent_memory/state/contracts/'. Hãy thực thi Stage 1 ngay."
            };
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

            // Nếu chưa có file nào, hệ thống tự động tạo một file mẫu để tham khảo
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

            // Đọc cấu hình NLAH tĩnh từ tệp tin
            const templateData = JSON.parse(fs.readFileSync(templatePath, 'utf8'));

            // Gán step_key và trạng thái PENDING ban đầu
            templateData.stages.forEach((stage, sIdx) => {
                stage.status = "PENDING";

                if (!stage.steps || !Array.isArray(stage.steps)) {
                    stage.steps = [];
                }

                stage.steps.forEach((step, stIdx) => {
                    step.status = "PENDING";
                    step.step_key = `stage_${sIdx}.step_${stIdx}`;
                    if (!step.parallel_group) step.parallel_group = null;
                    if (!step.depends_on) step.depends_on = [];
                });
            });

            // Khởi tạo thư mục File-Backed State
            const stateDir = path.join(memoryDir, 'state');
            const contractsDir = path.join(stateDir, 'contracts');
            const artifactsDir = path.join(stateDir, 'artifacts');
            if (!fs.existsSync(contractsDir)) fs.mkdirSync(contractsDir, { recursive: true });
            if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });

            // Lưu kế hoạch tĩnh vào SQLite
            const stmt = db.prepare(`INSERT OR REPLACE INTO pipelines (id, name, status, data) VALUES (?, ?, ?, ?)`);
            stmt.run('CURRENT', templateData.pipeline_name, 'IN_PROGRESS', JSON.stringify(templateData));

            // Đồng bộ trạng thái ban đầu ra SQLite và File-backed contracts
            const stateStmt = db.prepare(`INSERT OR REPLACE INTO agent_states (pipeline_id, step_key, state, retry_count, error_history, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
            const now = new Date().toISOString();

            for (const stage of templateData.stages) {
                for (const step of stage.steps) {
                    stateStmt.run('CURRENT', step.step_key, 'PENDING', 0, '[]', now); // Truyền đủ 6 tham số

                    // Thiết lập Hợp đồng thực thi (Execution Contract) tĩnh
                    const contract = {
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
                            value: `Kiểm tra xem tác vụ "${step.task}" đã được hoàn thành đúng chưa.`
                        },
                        output_artifact_path: path.join(artifactsDir, `${step.step_key}_artifact.json`).replace(/\\/g, '/')
                    };

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