import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';

export default {
    "run_advanced_tests": {
        description: "Chạy Unit Test trên MỘT file cụ thể và kiểm tra Linter (Code Quality) để tối ưu thời gian và tránh nhiễu log.",
        parameters: {
            type: "object",
            properties: {
                test_file: { type: "string", description: "Đường dẫn file test (VD: src/utils.test.js). Nếu để trống sẽ chạy toàn bộ." },
                check_lint: { type: "boolean", description: "Bật true để chạy ESLint/Pylint kiểm tra chất lượng code." },
                check_coverage: { type: "boolean", description: "Bật true để thu thập Test Coverage." }
            }
        },
        handler: async (args) => {
            const workspace = globalThis.activeWorkspace || process.cwd();
            const { test_file, check_lint, check_coverage } = args;
            let report = { status: "success", tests: "passed", linter: "passed", logs: "" };

            console.log(chalk.cyan(`\n[Advanced Tester] 🧪 Đang chạy kiểm thử...`));

            // 1. Chạy Linter (Chất lượng code)
            if (check_lint) {
                try {
                    let lintCmd = '';
                    if (fs.existsSync(path.join(workspace, '.eslintrc.json')) || fs.existsSync(path.join(workspace, 'eslint.config.js'))) {
                        lintCmd = `npx eslint ${test_file ? test_file.replace('.test.', '.') : '.'}`;
                    } else if (fs.existsSync(path.join(workspace, 'pytest.ini'))) {
                        lintCmd = `flake8 ${test_file ? test_file.replace('test_', '') : '.'}`;
                    }

                    if (lintCmd) {
                        execSync(lintCmd, { cwd: workspace, encoding: 'utf8', stdio: 'pipe' });
                    }
                } catch (error) {
                    report.linter = "failed";
                    report.logs += `\n[LINTER ERRORS]:\n${error.stdout?.toString().substring(0, 1000)}`;
                }
            }

            // 2. Chạy Unit Test (Xác định ngôn ngữ)
            try {
                let testCmd = '';
                const target = test_file ? `"${test_file}"` : '';
                const coverageFlag = check_coverage ? '--coverage' : '';

                if (fs.existsSync(path.join(workspace, 'package.json'))) {
                    // Jest/Vitest
                    testCmd = `npx jest ${target} ${coverageFlag}`;
                } else if (fs.existsSync(path.join(workspace, 'pytest.ini')) || fs.existsSync(path.join(workspace, 'requirements.txt'))) {
                    // Pytest
                    const covArgs = check_coverage ? '--cov=.' : '';
                    testCmd = `pytest ${target} ${covArgs}`;
                } else if (fs.existsSync(path.join(workspace, 'go.mod'))) {
                    const covArgs = check_coverage ? '-cover' : '';
                    testCmd = `go test ${target || './...'} ${covArgs}`;
                }

                if (testCmd) {
                    console.log(chalk.yellow(`[Advanced Tester] Thực thi: ${testCmd}`));
                    const output = execSync(testCmd, { cwd: workspace, encoding: 'utf8', stdio: 'pipe' });
                    report.logs += `\n[TEST RESULTS]:\n${output.substring(0, 2000)}`;
                } else {
                    report.logs += "\n[WARNING]: Không nhận diện được Test Framework để chạy.";
                }

            } catch (error) {
                report.status = "failed";
                report.tests = "failed";
                const errLog = `${error.stdout?.toString()}\n${error.stderr?.toString()}`;
                report.logs += `\n[TEST FAILURES]:\n${errLog.substring(0, 3000)}`;
            }

            // Xử lý đầu ra JSON chuẩn cho FSM
            if (report.status === "failed" || report.linter === "failed") {
                console.log(chalk.red(`[Advanced Tester] ❌ Phát hiện lỗi Test/Lint!`));
            } else {
                console.log(chalk.green(`[Advanced Tester] ✅ Test & Lint Pass hoàn toàn!`));
            }

            return JSON.stringify(report);
        }
    }
};