const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

module.exports = {
    "git_create_checkpoint": {
        description: "[CỰC KỲ QUAN TRỌNG] Tạo một điểm neo an toàn (Snapshot) cho toàn bộ code. BẮT BUỘC gọi hàm này TRƯỚC KHI sửa đổi logic phức tạp, xóa code, hoặc sửa nhiều file cùng lúc.",
        parameters: {
            type: "object",
            properties: {
                message: { 
                    type: "string", 
                    description: "Lý do tạo checkpoint (VD: 'Before refactoring login API')" 
                }
            },
            required: ["message"]
        },
        handler: async (args) => {
            const cwd = process.cwd();
            const message = args.message || "Auto checkpoint";
            console.log(`\n[Git] 🛡️ Đang tạo Checkpoint an toàn: ${message}...`);
            
            try {
                // Kiểm tra xem thư mục đã là git repo chưa, nếu chưa thì init
                await execPromise('git rev-parse --is-inside-work-tree', { cwd }).catch(() => execPromise('git init', { cwd }));
                
                // Add tất cả thay đổi và commit
                await execPromise('git add -A', { cwd });
                const { stdout } = await execPromise(`git commit -m "[AI Backup] ${message}"`, { cwd });
                
                return { 
                    status: "success", 
                    message: "Đã lưu trữ toàn bộ mã nguồn an toàn. Bạn có thể thoải mái sửa code. Nếu hỏng, hãy dùng git_rollback_checkpoint.",
                    details: stdout.trim()
                };
            } catch (error) {
                // Nếu không có thay đổi nào để commit, Git sẽ throw error, ta catch lại và báo ok.
                if (error.stdout && error.stdout.includes('nothing to commit')) {
                    return { status: "success", message: "Codebase đang nguyên vẹn (không có thay đổi nào từ lần backup trước). Có thể tiến hành sửa code." };
                }
                throw new Error(`Không thể tạo checkpoint: ${error.message}`);
            }
        }
    },

    "git_rollback_checkpoint": {
        description: "[CỨU HỘ KHẨN CẤP] Khôi phục toàn bộ mã nguồn về điểm Checkpoint gần nhất. Gọi hàm này NGAY LẬP TỨC nếu bạn vừa sửa code mà chạy test bị lỗi, hoặc sửa nhầm file.",
        parameters: {
            type: "object",
            properties: {
                undo_last_commit: {
                    type: "boolean",
                    description: "Set là true nếu muốn xóa luôn cả điểm Checkpoint gần nhất. Mặc định là false (chỉ xóa những code chưa commit)."
                }
            }
        },
        handler: async (args) => {
            const cwd = process.cwd();

            if (!global.isAutoApproveAll) {
                console.log(`\n\x1b[41m\x1b[37m ⚠️ AI YÊU CẦU ROLLBACK (KHÔI PHỤC) CODE \x1b[0m`);
                const answer = await global.askPermission(`👉 Thao tác này sẽ XÓA BỎ toàn bộ code lỗi AI vừa viết. Cho phép? [y/a/n] : `);
                if (answer === 'a') global.isAutoApproveAll = true; 
                else if (answer !== 'y') throw new Error("PERMISSION_DENIED: Người dùng từ chối khôi phục code.");
            }

            console.log(`\n[Git] 🔄 Đang khôi phục mã nguồn về trạng thái an toàn...`);
            try {
                // 1. Khôi phục các file đã bị sửa (nhưng chưa commit)
                await execPromise('git reset --hard HEAD', { cwd });
                // 2. Xóa các file rác/mới tạo mà chưa commit
                await execPromise('git clean -fd', { cwd });

                // 3. Nếu AI muốn lùi lại 1 commit nữa
                if (args.undo_last_commit) {
                    await execPromise('git reset --hard HEAD~1', { cwd });
                }

                return { 
                    status: "success", 
                    message: "Mã nguồn đã được khôi phục thành công. Vui lòng phân tích lại lỗi trước đó và tìm cách tiếp cận mới." 
                };
            } catch (error) {
                throw new Error(`Lỗi khôi phục: ${error.message}`);
            }
        }
    }
};