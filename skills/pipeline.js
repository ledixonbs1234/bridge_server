import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
                                        task: { type: "string", description: "Mô tả công việc" },
                                        tool: { type: "string", description: "Tên skill dự kiến sử dụng (VD: read_file, execute_terminal_command)" }
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
            fs.writeFileSync(planFile, JSON.stringify(args, null, 2), 'utf8');
            return { 
                status: "success", 
                message: "Pipeline đã được người dùng PHÊ DUYỆT. Hãy bắt đầu thực thi Stage 1 ngay bây giờ. Nhớ gọi update_pipeline_status sau mỗi Stage." 
            };
        }
    },

    "update_pipeline_status": {
        description: "Đánh dấu tiến độ của Pipeline (DONE hoặc FAILED cho từng Stage) để AI không bị quên mình đang làm tới đâu.",
        parameters: {
            type: "object",
            properties: {
                stage_index: { type: "number", description: "Vị trí của Stage vừa làm xong (bắt đầu từ 0)" },
                status: { type: "string", enum: ["IN_PROGRESS", "DONE", "FAILED"] },
                notes: { type: "string", description: "Ghi chú thêm (VD: Kết quả thu được, hoặc lý do fail)" }
            },
            required: ["stage_index", "status"]
        },
        handler: async (args) => {
            const planFile = path.join(__dirname, '..', '.agent_memory', 'CURRENT_PIPELINE.json');
            if (!fs.existsSync(planFile)) throw new Error("Không có Pipeline nào đang chạy.");

            const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
            if (args.stage_index < 0 || args.stage_index >= plan.stages.length) {
                throw new Error("stage_index không hợp lệ.");
            }

            // Cập nhật trạng thái
            plan.stages[args.stage_index].status = args.status;
            if (args.notes) plan.stages[args.stage_index].notes = args.notes;

            // Đổi màu log dựa trên status
            const color = args.status === "DONE" ? "\x1b[32m" : args.status === "FAILED" ? "\x1b[31m" : "\x1b[33m";
            
            fs.writeFileSync(planFile, JSON.stringify(plan, null, 2), 'utf8');
            console.log(`\n[Pipeline] 🔄 Stage ${args.stage_index + 1} (${plan.stages[args.stage_index].name}) -> ${color}${args.status}\x1b[0m`);

            if (args.status === "DONE" && args.stage_index === plan.stages.length - 1) {
                 return { status: "success", message: "CHÚC MỪNG! Toàn bộ Pipeline đã hoàn tất." };
            }

            return { status: "success", message: `Đã cập nhật trạng thái. Hãy chuyển sang thực thi Stage tiếp theo.` };
        }
    }
};