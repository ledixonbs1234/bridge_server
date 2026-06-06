import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { loadSkills, SKILL_REGISTRY } from './services/skillLoader.js';

// Cấu hình môi trường an toàn giả lập
globalThis.activeWorkspace = process.cwd().replace(/\\/g, '/');
global.isAutoApproveAll = true; // Đặt true để tự động chạy không cần hỏi duyệt, đặt false nếu muốn hiện khung duyệt HITL

async function run() {
    const args = process.argv.slice(2);
    const jsonFileName = args[0] || 'json_write.json';
    const jsonPath = path.resolve(process.cwd(), jsonFileName);

    if (!fs.existsSync(jsonPath)) {
        console.error(chalk.red(`❌ Lỗi: Không tìm thấy tệp JSON tại: ${jsonPath}`));
        console.log(chalk.gray(`Cách sử dụng: node run_skill_from_json.js <tên_file_json>`));
        return;
    }

    try {
        // 1. Đọc và parse dữ liệu từ tệp JSON
        const rawData = fs.readFileSync(jsonPath, 'utf8');
        const parsed = JSON.parse(rawData);

        // Hỗ trợ nhiều định dạng từ khóa khác nhau (tùy biến hoặc chuẩn của OpenAI/Qwen)
        const skillName = parsed.skill || parsed.name || parsed.tool;
        const skillArguments = parsed.arguments || parsed.args || parsed.parameters || {};

        if (!skillName) {
            console.error(chalk.red("❌ File JSON không đúng định dạng. Phải chứa thuộc tính 'skill', 'name' hoặc 'tool'."));
            console.log(chalk.gray("Mẫu cấu trúc JSON hợp lệ để hệ thống tự động nhận diện:"));
            console.log(chalk.yellow(JSON.stringify({
                skill: "replace_content_safe",
                arguments: {
                    file_path: "temp.txt",
                    target_content: "nội dung cũ",
                    replacement_content: "nội dung mới",
                    start_line: 1,
                    end_line: 1
                }
            }, null, 2)));
            return;
        }

        console.log(chalk.cyan(`\n🔍 Đang khởi tạo và đăng ký các kỹ năng của hệ thống...`));
        // 2. Nạp toàn bộ Hard/Soft skills thực tế của dự án thông qua skillLoader
        await loadSkills();

        // 3. Truy vết và tìm kiếm handler tương ứng trong SKILL_REGISTRY
        const skill = SKILL_REGISTRY[skillName];
        if (!skill) {
            console.error(chalk.red(`❌ Không tìm thấy công cụ (skill) nào đăng ký dưới tên: "${skillName}"`));
            console.log(chalk.gray(`Các công cụ hiện có: ${Object.keys(SKILL_REGISTRY).join(', ')}`));
            return;
        }

        console.log(chalk.green(`✅ Phát hiện công cụ hợp lệ: [${skillName}]`));
        console.log(chalk.gray(`Mô tả: ${skill.description}`));
        console.log(chalk.cyan(`⚙️ Đang tiến hành thực thi hành động...`));

        // 4. Kích hoạt chạy trực tiếp handler của skill tìm được
        const result = await skill.handler(skillArguments);

        console.log(chalk.bold.green('\n🎉 KẾT QUẢ THỰC THI TRẢ VỀ:'));
        if (typeof result === 'string') {
            console.log(result);
        } else {
            console.log(JSON.stringify(result, null, 2));
        }

    } catch (err) {
        console.error(chalk.red(`\n❌ Lỗi trong quá trình xử lý tự động: ${err.message}`));
    }
    console.log(chalk.gray('\n------------------------------------------------------------------\n'));
}

run();