import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../database.js';
// Fix lỗi __dirname trong ES Module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
    "create_pipeline_plan": {
        description: "[QUAN TRỌNG] Lập kế hoạch Pipeline. BẮT BUỘC dùng công cụ này ĐẦU TIÊN khi người dùng giao một task lớn, phức tạp. Phân chia task thành các Stages (giai đoạn) và Steps (bước) giống như Harness CI/CD.",
        parameters: {
            type: "object",
            properties: {
                pipeline_name: { type: "string", description: "Tên của pipeline (VD: Xây dựng tính năng Auth)" },
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
                                        validation: {
                                            type: "object",
                                            description: "Phương thức kiểm tra kết quả bước này (Không bắt buộc, động cơ tự suy luận nếu để trống)",
                                            properties: {
                                                type: { type: "string", enum: ["command", "file_exists", "llm_check"], description: "Loại validation: chạy lệnh terminal, kiểm tra file tồn tại, hoặc dùng LLM tự kiểm tra." },
                                                value: { type: "string", description: "Lệnh chạy, đường dẫn file, hoặc prompt mô tả tiêu chí kiểm tra cho LLM." }
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
            required: ["pipeline_name", "stages"]
        },
        handler: async (args) => {
            const memoryDir = path.join(process.cwd(), '.agent_memory');
            const planFile = path.join(memoryDir, 'CURRENT_PIPELINE.json');

            if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

            // Khởi tạo trạng thái mặc định
            args.stages.forEach(stage => {
                stage.status = "PENDING";
                stage.steps.forEach(step => step.status = "PENDING");
            });

            // In ra Terminal giao diện đẹp mắt giống CI/CD
            console.log(`\n\x1b[44m\x1b[37m 📋 AI ĐỀ XUẤT PIPELINE: ${args.pipeline_name.toUpperCase()} \x1b[0m`);
            args.stages.forEach((stage, sIdx) => {
                console.log(`\x1b[36mStage ${sIdx + 1}: ${stage.name}\x1b[0m`);
                stage.steps.forEach((step, stIdx) => {
                    console.log(`   ├─ [ ] ${step.task} (Tool dự kiến: \x1b[33m${step.tool}\x1b[0m)`);
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

            // Lưu kế hoạch vào bộ nhớ
            const stmt = db.prepare(`INSERT OR REPLACE INTO pipelines (id, name, status, data) VALUES (?, ?, ?, ?)`);
            stmt.run('CURRENT', args.pipeline_name, 'IN_PROGRESS', JSON.stringify(args));
            return {
                status: "success",
                message: "Pipeline đã được người dùng PHÊ DUYỆT. Hãy bắt đầu thực thi Stage 1 ngay bây giờ. Nhớ gọi update_pipeline_status sau mỗi Stage."
            };
        }
    },

};