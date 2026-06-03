import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';
import chalk from 'chalk';
import { execSync } from 'child_process'; // Thêm module để kiểm tra môi trường

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

export const SKILL_REGISTRY = {};

// Tự động kiểm tra xem môi trường đã cài đặt bun hay chưa
let bunX = 'bun';
try {
    execSync('bun --version', { stdio: 'ignore' });
} catch (e) {
    bunX = 'npx -y bun';
}

export async function loadSkills() {
    for (const key in SKILL_REGISTRY) {
        delete SKILL_REGISTRY[key];
    }

    let totalHardSkills = 0;
    let totalSoftSkills = 0;

    // Load Hard Skills (.js)
    const skillsDir = path.join(projectRoot, 'skills');
    if (!fs.existsSync(skillsDir)) {
        fs.mkdirSync(skillsDir);
    } else {
        const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.js'));
        for (const file of files) {
            try {
                const fileUrl = pathToFileURL(path.join(skillsDir, file)).href;
                const pluginModule = await import(fileUrl);
                const plugin = pluginModule.default;

                if (!plugin) continue;

                for (const [skillName, skillDef] of Object.entries(plugin)) {
                    if (skillDef && typeof skillDef === 'object' && typeof skillDef.description === 'string') {
                        SKILL_REGISTRY[skillName] = skillDef;
                        totalHardSkills++;
                    } else {
                        continue;
                    }
                }
            } catch (err) {
                console.error(`[Plugin] ❌ Lỗi nạp JS ${file}:`, err.message);
            }
        }
    }

    // Load Soft Skills (.md)
    const agentSkillsDir = path.join(projectRoot, '.agents', 'skills');
    if (!fs.existsSync(agentSkillsDir)) {
        fs.mkdirSync(agentSkillsDir, { recursive: true });
    } else {
        const folders = fs.readdirSync(agentSkillsDir);
        folders.forEach(folder => {
            if (!fs.statSync(path.join(agentSkillsDir, folder)).isDirectory()) return;

            const skillFilePath = path.join(agentSkillsDir, folder, 'SKILL.md');
            if (fs.existsSync(skillFilePath)) {
                try {
                    const content = fs.readFileSync(skillFilePath, 'utf8');
                    const match = content.match(/(?:^|\n)---\s*\n([\s\S]*?)\n---\s*(?:\n|$)([\s\S]*)/);

                    if (match) {
                        const yamlData = yaml.load(match[1]);
                        const markdownBody = match[2].trim();
                        const rawName = yamlData.name || folder;
                        const skillName = rawName.replace(/-/g, '_');

                        // Lấy đường dẫn tuyệt đối của thư mục chứa kỹ năng này
                        const baseDirAbsolute = path.dirname(skillFilePath).replace(/\\/g, '/');

                        // Tự động thay thế các biến giữ chỗ {baseDir} và ${BUN_X}
                        const optimizedMarkdownBody = markdownBody
                            .replace(/\{baseDir\}/g, baseDirAbsolute)
                            .replace(/\$\{BUN_X\}/g, bunX);

                        SKILL_REGISTRY[`workflow_${skillName}`] = {
                            description: `[HƯỚNG DẪN QUY TRÌNH] ${yamlData.description || 'Quy trình thực hiện'}. Gọi hàm này ĐẦU TIÊN (không cần tham số) để đọc sổ tay hướng dẫn trước khi làm nhiệm vụ.`,
                            handler: async () => {
                                console.log(`\n[Node] 📖 AI đang đọc sổ tay hướng dẫn: \x1b[36m${skillName}\x1b[0m`);
                                return {
                                    message: "Hãy đọc kỹ hướng dẫn dưới đây và sử dụng execute_terminal_command hoặc các skill khác để thực thi từng bước.",
                                    workflow_instructions: optimizedMarkdownBody
                                };
                            }
                        };
                        totalSoftSkills++;
                    }
                } catch (err) {
                    console.error(`[Plugin] ❌ Lỗi nạp Markdown skill ${folder}:`, err.message);
                }
            }
        });
    }

    console.log(`\n[Node] 🧠 Đã nạp: \x1b[32m${totalHardSkills} Hard Skills (.js)\x1b[0m | \x1b[36m${totalSoftSkills} Soft Skills (.md)\x1b[0m`);
}

// Thiết lập Hot Reload
export function setupHotReload() {
    let debounceSkillTimer = null;
    const watchDir = path.join(projectRoot, '.agents', 'skills');
    if (!fs.existsSync(watchDir)) fs.mkdirSync(watchDir, { recursive: true });

    fs.watch(watchDir, { recursive: true }, (eventType, filename) => {
        if (filename && filename.endsWith('SKILL.md')) {
            clearTimeout(debounceSkillTimer);
            debounceSkillTimer = setTimeout(async () => {
                console.log(chalk.cyan(`\n[Plugin] 🔄 Thay đổi được phát hiện ở skill: ${filename}. Đang reload...`));
                await loadSkills();

                try {
                    const botModule = await import('../ai_studio_bot.js');
                    if (botModule.default && botModule.default.setupFlags) {
                        botModule.default.setupFlags.functions = false;
                        console.log(chalk.gray(`[Plugin] ⚙️ Đã báo Gemini Studio cài đặt lại Function Calling trên trình duyệt.`));
                    }
                } catch (e) { }
            }, 1000);
        }
    });
}