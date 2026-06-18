import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';

export default {
    "run_automated_tests": {
        description: "Tự động phát hiện framework testing của dự án (Node.js, Python, C#, Go, Rust) và chạy toàn bộ các bài kiểm thử tự động (Unit/Integration Tests). Trả về kết quả Pass/Fail và Log lỗi chi tiết.",
        parameters: {
            type: "object",
            properties: {
                target_path: {
                    type: "string",
                    description: "Đường dẫn thư mục chứa code cần test. Để trống sẽ tự động lấy Workspace hiện tại."
                }
            }
        },
        handler: async (args) => {
            const workspace = args.target_path || globalThis.activeWorkspace || process.cwd();

            if (!fs.existsSync(workspace)) {
                throw new Error(`Thư mục không tồn tại: ${workspace}`);
            }

            console.log(chalk.cyan(`\n[Test Runner] 🧪 Đang quét môi trường testing tại: ${workspace}...`));

            let command = null;

            // 1. Nhận diện Node.js / TypeScript (NPM/Yarn/Bun)
            if (fs.existsSync(path.join(workspace, 'package.json'))) {
                const pkg = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
                if (pkg.scripts && pkg.scripts.test) {
                    const hasBun = fs.existsSync(path.join(workspace, 'bun.lockb'));
                    const hasYarn = fs.existsSync(path.join(workspace, 'yarn.lock'));
                    command = hasBun ? 'bun test' : (hasYarn ? 'yarn test' : 'npm test');
                } else if (fs.existsSync(path.join(workspace, 'jest.config.js'))) {
                    command = 'npx jest';
                }
            }

            // 2. Nhận diện Python (Pytest / Unittest)
            else if (fs.existsSync(path.join(workspace, 'requirements.txt')) || fs.existsSync(path.join(workspace, 'pytest.ini')) || fs.existsSync(path.join(workspace, 'tests'))) {
                try {
                    execSync('pytest --version', { stdio: 'ignore' });
                    command = 'pytest';
                } catch {
                    command = 'python -m unittest discover -s tests';
                }
            }

            // 3. Nhận diện C# (.NET)
            else if (fs.readdirSync(workspace).some(f => f.endsWith('.sln') || f.endsWith('.csproj'))) {
                command = 'dotnet test';
            }

            // 4. Nhận diện Golang
            else if (fs.existsSync(path.join(workspace, 'go.mod'))) {
                command = 'go test ./...';
            }

            // 5. Nhận diện Rust
            else if (fs.existsSync(path.join(workspace, 'Cargo.toml'))) {
                command = 'cargo test';
            }

            if (!command) {
                return JSON.stringify({
                    status: "warning",
                    message: "Không tìm thấy cấu hình testing framework chuẩn (package.json, pytest, dotnet, go.mod, v.v.). Không có bài test nào được chạy."
                });
            }

            console.log(chalk.yellow(`[Test Runner] ⚙️ Phát hiện framework. Chạy lệnh: ${command}`));

            try {
                const output = execSync(command, {
                    cwd: workspace,
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                return JSON.stringify({
                    status: "success",
                    command_run: command,
                    output: output.substring(0, 3000) // Cắt bớt log dài để tiết kiệm token
                });
            } catch (error) {
                const stderr = error.stderr ? error.stderr.toString() : '';
                const stdout = error.stdout ? error.stdout.toString() : '';
                const fullLog = `${stdout}\n${stderr}`.substring(0, 5000);

                console.log(chalk.red(`[Test Runner] ❌ Tests Failed!`));

                return JSON.stringify({
                    status: "failed",
                    command_run: command,
                    error_log: fullLog,
                    suggestion: "Có bài kiểm thử thất bại. Hãy đọc 'error_log', tìm ra dòng code gây lỗi logic và yêu cầu Healer sửa chữa."
                });
            }
        }
    }
};