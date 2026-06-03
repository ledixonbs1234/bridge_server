// filepath: bridge_server/skills/ask_questions.js
import chalk from 'chalk';

export default {
    "ask_questions_if_underspecified": {
        description: "Hỏi ý kiến người dùng khi bối cảnh hoặc yêu cầu của tác vụ chưa rõ ràng (underspecified). Bắt buộc sử dụng công cụ này khi có nhiều phương án lựa chọn mà bạn không chắc chắn. Kết quả trả về sẽ là một chuỗi JSON chứa đầy đủ câu trả lời của người dùng cho từng câu hỏi để bạn phân tích và suy nghĩ tiếp.",
        parameters: {
            type: "object",
            properties: {
                explanation: {
                    type: "string",
                    description: "Lời giải thích bằng tiếng Việt về lý do tại sao các câu hỏi này là quan trọng và cần được làm rõ trước khi tiếp tục thực hiện."
                },
                questions: {
                    type: "array",
                    description: "Danh sách các câu hỏi có cấu trúc cần người dùng trả lời.",
                    items: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string",
                                description: "ID định danh duy nhất của câu hỏi (tiếng Anh, viết liền không dấu, ví dụ: 'scope', 'auth_provider')."
                            },
                            question: {
                                type: "string",
                                description: "Nội dung câu hỏi cụ thể bằng tiếng Việt."
                            },
                            type: {
                                type: "string",
                                enum: ["select", "multi_select", "text"],
                                description: "Kiểu câu hỏi: 'select' (chọn một), 'multi_select' (chọn nhiều), hoặc 'text' (nhập văn bản tự do)."
                            },
                            options: {
                                type: "array",
                                description: "Các phương án lựa chọn có sẵn (bắt buộc đối với kiểu 'select' hoặc 'multi_select').",
                                items: {
                                    type: "object",
                                    properties: {
                                        label: { type: "string", description: "Nhãn mô tả trực quan hiển thị trên nút bấm." },
                                        value: { type: "string", description: "Giá trị kỹ thuật tương ứng được lưu trữ." },
                                        is_default: { type: "boolean", description: "Đánh dấu là phương án mặc định được hệ thống đề xuất." }
                                    },
                                    required: ["label", "value"]
                                }
                            },
                            allow_custom: {
                                type: "boolean",
                                description: "Cho phép người dùng tự nhập ý kiến/phương án khác của riêng họ ngoài các phương án có sẵn."
                            }
                        },
                        required: ["id", "question", "type"]
                    }
                }
            },
            required: ["explanation", "questions"]
        },
        handler: async (args) => {
            let { explanation, questions } = args;

            // Phòng ngừa trường hợp mô hình truyền nhầm chuỗi JSON String thay vì Array
            if (typeof questions === 'string') {
                try {
                    questions = JSON.parse(questions);
                } catch (e) {
                    throw new Error(`Tham số questions không hợp lệ (Không thể parse JSON). Chi tiết: ${e.message}`);
                }
            }

            if (!Array.isArray(questions)) {
                throw new Error("Tham số questions không đúng định dạng mảng (Array).");
            }

            const payload = {
                type: "structured_questions",
                explanation,
                questions
            };

            console.log(chalk.yellow(`\n[Ask Questions] ❓ AI yêu cầu làm rõ bối cảnh:`));
            console.log(chalk.gray(`Lý do: `) + chalk.white(explanation));

            const detailsStr = JSON.stringify(payload);

            // Gọi askPermission với thông tin chi tiết được ghi đè bằng chuỗi JSON câu hỏi
            const response = await global.askPermission(
                `AI đang yêu cầu làm rõ một số bối cảnh kỹ thuật trước khi tiếp tục thực hiện công việc.`,
                detailsStr
            );

            return response;
        }
    }
};