// test_run_skill.js
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import os from 'os';

// 1. Phân tích động file cấu hình JSON trước khi nạp Skill để giả lập môi trường đường dẫn an toàn
const args = process.argv.slice(2);
const jsonFileName = args[0] || 'json_write.json';
const jsonPath = path.resolve(process.cwd(), jsonFileName);

if (fs.existsSync(jsonPath)) {
    try {
        const rawData = fs.readFileSync(jsonPath, 'utf8');
        const parsed = JSON.parse(rawData);
        const skillArguments = parsed.arguments || parsed.args || parsed.parameters || {};

        // Tìm kiếm đường dẫn tệp tin hoặc thư mục mục tiêu trong tham số kiểm thử
        const testFilePath = skillArguments.file_path ||
            skillArguments.path ||
            skillArguments.directory_path ||
            skillArguments.target ||
            (Array.isArray(skillArguments.file_paths) ? skillArguments.file_paths[0] : null);

        if (testFilePath) {
            const absoluteTestPath = path.resolve(testFilePath);
            const parsedPath = path.parse(absoluteTestPath);
            // Lấy thư mục chứa file hoặc chính thư mục gốc của đường dẫn kiểm thử
            const testDir = parsedPath.dir || parsedPath.root;

            if (testDir) {
                console.log(chalk.blue(`[Test Helper] 🛠️ Giả lập os.homedir() để cho phép đường dẫn: ${testDir}`));
                // Ghi đè các hàm hệ thống và biến môi trường trước khi các module skill được nạp động
                os.homedir = () => testDir.replace(/\\/g, '/');
                process.env.USERPROFILE = testDir;
                process.env.HOME = testDir;

                // Thiết lập workspace an toàn tương ứng
                globalThis.activeWorkspace = testDir.replace(/\\/g, '/');
            }
        }
    } catch (e) {
        console.warn(chalk.yellow(`[Test Helper] Không thể trích xuất cấu trúc JSON sớm: ${e.message}`));
    }
}

// Cấu hình mặc định nếu không tìm thấy hoặc không giả lập được từ file JSON
if (!globalThis.activeWorkspace) {
    globalThis.activeWorkspace = process.cwd().replace(/\\/g, '/');
}
global.isAutoApproveAll = true; // Tự động duyệt chạy thử nghiệm

// 2. Tiến hành nạp các module skill và thực thi
import { loadSkills, SKILL_REGISTRY } from './services/skillLoader.js';

async function run() {
    if (!fs.existsSync(jsonPath)) {
        console.error(chalk.red(`❌ Lỗi: Không tìm thấy tệp JSON tại: ${jsonPath}`));
        console.log(chalk.gray(`Cách sử dụng: node test_run_skill.js <tên_file_json>`));
        return;
    }

    try {
        const rawData = fs.readFileSync(jsonPath, 'utf8');
        const parsed = JSON.parse(rawData);

        const skillName = parsed.skill || parsed.name || parsed.tool;
        const skillArguments = parsed.arguments || parsed.args || parsed.parameters || {};

        if (!skillName) {
            console.error(chalk.red("❌ File JSON không đúng định dạng. Phải chứa thuộc tính 'skill', 'name' hoặc 'tool'."));
            return;
        }

        console.log(chalk.cyan(`\n🔍 Đang khởi tạo và đăng ký các kỹ năng của hệ thống...`));
        await loadSkills();

        const skill = SKILL_REGISTRY[skillName];
        if (!skill) {
            console.error(chalk.red(`❌ Không tìm thấy công cụ (skill) nào đăng ký dưới tên: "${skillName}"`));
            console.log(chalk.gray(`Các công cụ hiện có: ${Object.keys(SKILL_REGISTRY).join(', ')}`));
            return;
        }

        console.log(chalk.green(`✅ Phát hiện công cụ hợp lệ: [${skillName}]`));
        console.log(chalk.gray(`Mô tả: ${skill.description}`));
        console.log(chalk.cyan(`⚙️ Đang tiến hành thực thi hành động...`));

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