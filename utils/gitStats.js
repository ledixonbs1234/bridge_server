// ridge_server/utils/gitStats.js
import { execSync } from 'child_process';
import path from 'path';

export function getGitDiffStats(targetWorkspace) {
    try {
        if (!targetWorkspace) return [];

        const cwd = targetWorkspace;

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

// Kiểm tra xem Workspace hiện hành có phải là Git Repository hay không
export function isGitRepository(dir) {
    if (!dir) return false;
    try {
        execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

// Khởi chạy quy trình tự động cô lập Git (Git Isolation) - Cấp độ Turn Chat
export function startGitIsolation(dir, taskDescription) {
    if (!isGitRepository(dir)) return null;
    try {
        let currentBranch = "";
        try {
            currentBranch = execSync('git branch --show-current', { cwd: dir, encoding: 'utf8' }).trim();
        } catch {
            currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, encoding: 'utf8' }).trim();
        }

        // Nếu đã ở trên nhánh tạm, tái sử dụng nhánh này và không tạo nhánh mới hay stash nữa
        if (currentBranch.startsWith('temp/fix-')) {
            console.log(`[Git Isolation] Đang ở trên nhánh cô lập hoạt động: ${currentBranch}. Tiếp tục thực thi...`);
            return {
                alreadyIsolated: true,
                tempBranch: currentBranch
            };
        }

        const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' }).trim();
        const isDirty = status.length > 0;

        if (isDirty) {
            execSync('git stash -u -m "agent-stash-temp"', { cwd: dir });
        }

        const safeTaskName = taskDescription
            ? taskDescription.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 20)
            : 'patch';
        const tempBranch = `temp/fix-${safeTaskName}-${Math.random().toString(36).substring(2, 7)}`;

        execSync(`git checkout -b ${tempBranch}`, { cwd: dir });

        return {
            alreadyIsolated: false,
            currentBranch,
            tempBranch,
            isDirty
        };
    } catch (err) {
        console.error('[Git Isolation] Gặp sự cố khi bắt đầu cô lập:', err.message);
        return null;
    }
}

// Kết thúc quy trình cô lập Git (Tạo commit khi thành công hoặc hoàn tác khi thất bại)
export function endGitIsolation(dir, isolationState, success = true) {
    if (!isolationState) return;
    try {
        const { alreadyIsolated, currentBranch, tempBranch, isDirty } = isolationState;

        if (success) {
            execSync('git add .', { cwd: dir });
            try {
                execSync('git commit -m "fix: automatic patch by agent"', { cwd: dir });
                console.log(`[Git Isolation] Đã tự động tạo commit thành công trên nhánh ${tempBranch || isolationState.tempBranch}`);
            } catch (commitErr) {
                console.log('[Git Isolation] Không có thay đổi nào để tạo commit:', commitErr.message);
            }
            // KHÔNG checkout quay lại currentBranch nếu thành công để người dùng có thể làm việc trực tiếp trên nhánh tạm này.
        } else {
            // Hoàn tác mọi thay đổi dở dang trên nhánh tạm
            execSync('git reset --hard', { cwd: dir });

            // Nếu nhánh này được tạo mới trong lượt này (alreadyIsolated === false), thì mới dọn dẹp và trả về nhánh gốc
            if (!alreadyIsolated) {
                execSync(`git checkout ${currentBranch}`, { cwd: dir });

                try {
                    execSync(`git branch -D ${tempBranch}`, { cwd: dir });
                } catch { }

                // Khôi phục các thay đổi dở dang gốc từ stash
                if (isDirty) {
                    try {
                        execSync('git stash pop', { cwd: dir });
                    } catch (stashErr) {
                        console.warn('[Git Isolation] Cảnh báo khôi phục stash:', stashErr.message);
                    }
                }
            }
        }
    } catch (err) {
        console.error('[Git Isolation] Lỗi khi kết thúc cô lập:', err.message);
    }
}

// Tạo Chat Footer siêu tối giản cung cấp bối cảnh Git & Workspace & Trạng thái đọc tệp tin
export function getGitFooterContext(targetWorkspace) {
    if (!targetWorkspace) return "";
    try {
        execSync('git rev-parse --is-inside-work-tree', { cwd: targetWorkspace, stdio: 'ignore' });
        let branch = "";
        try {
            branch = execSync('git branch --show-current', { cwd: targetWorkspace, encoding: 'utf8' }).trim();
        } catch {
            branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: targetWorkspace, encoding: 'utf8' }).trim();
        }

        const diffs = getGitDiffStats(targetWorkspace);
        const modifiedFiles = diffs.map(d => d.file).filter(Boolean);

        // Trích xuất trạng thái đọc/chưa đọc của các tệp đã sửa trong phiên hiện hành
        const tracker = globalThis.fileTracker || {};
        const trackingList = [];
        for (const [absPath, info] of Object.entries(tracker)) {
            const relativeName = path.relative(targetWorkspace, absPath).replace(/\\/g, '/');
            const statusIcon = info.readAfterWrite ? "(Đã đọc)" : "(Chưa đọc)";
            trackingList.push(`${relativeName}${statusIcon}`);
        }

        const modStr = trackingList.length > 0
            ? trackingList.join(',')
            : (modifiedFiles.length > 0 ? modifiedFiles.join(',') : "None");

        const folderName = path.basename(targetWorkspace);
        return `\n\n📌 [Git: ${branch} | Dir: ${folderName} | Mod: ${modStr}]`;
    } catch (e) {
        try {
            const folderName = path.basename(targetWorkspace);
            const tracker = globalThis.fileTracker || {};
            const trackingList = [];
            for (const [absPath, info] of Object.entries(tracker)) {
                const relativeName = path.relative(targetWorkspace, absPath).replace(/\\/g, '/');
                const statusIcon = info.readAfterWrite ? "(Đã đọc)" : "(Chưa đọc)";
                trackingList.push(`${relativeName}${statusIcon}`);
            }
            const modStr = trackingList.length > 0 ? trackingList.join(',') : "None";
            return `\n\n📌 [Git: None | Dir: ${folderName} | Mod: ${modStr}]`;
        } catch {
            return "";
        }
    }
}