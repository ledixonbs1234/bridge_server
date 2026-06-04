import { execSync } from 'child_process';
import path from 'path';

export function getGitDiffStats(targetWorkspace) {
    try {
        // Chỉ chạy nếu có workspace của dự án được chỉ định cụ thể
        if (!targetWorkspace) return [];

        const cwd = targetWorkspace;

        // Thêm các file mới vào index dưới dạng "intent-to-add" để git diff HEAD có thể nhận diện được cả file mới tạo (untracked)
        try {
            execSync('git add -N .', { cwd: cwd, stdio: 'ignore' });
        } catch (e) {
            // Thầm lặng bỏ qua nếu lệnh không khả dụng
        }

        const diffOutput = execSync('git diff HEAD', {
            cwd: cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const fileDiffs = diffOutput.split(/^diff --git /m);
        const files = [];

        for (const fileDiff of fileDiffs) {
            if (!fileDiff.trim()) continue;
            const lines = fileDiff.split('\n');
            const headerLine = lines[0];
            const match = headerLine.match(/a\/(.+?)\s+b\/(.+)$/);
            if (!match) continue;
            const filename = match[1];

            // BỎ QUA CÁC TIẾN TRÌNH NỘI BỘ VÀ FILE HỆ THỐNG CỦA BRIDGE_SERVER
            if (filename.startsWith('.agent_memory') ||
                filename.startsWith('profile') ||
                filename.startsWith('bridge_server') ||
                filename.includes('agent_state.json')) {
                continue;
            }

            let additions = 0;
            let deletions = 0;
            for (const line of lines) {
                if (line.startsWith('+') && !line.startsWith('+++')) additions++;
                if (line.startsWith('-') && !line.startsWith('---')) deletions++;
            }

            let status = 'modified';
            if (fileDiff.includes('new file mode')) status = 'added';
            else if (fileDiff.includes('deleted file mode')) status = 'deleted';

            files.push({
                file: filename,
                status: status,
                additions: additions,
                deletions: deletions,
                diff: fileDiff
            });
        }
        return files;
    } catch (e) {
        return [];
    }
}