import os from 'os';

export default {
    "get_os_context": {
        description: "Lấy thông tin hệ điều hành (Windows/macOS/Linux), thư mục hiện hành và thư mục home. Hãy dùng lệnh này để biết mình đang ở đâu và viết lệnh Terminal cho đúng.",
        handler: async () => {
            console.log(`\n[Node] 🔍 AI đang lấy thông tin hệ điều hành...`);
            return {
                os_platform: os.platform(),
                os_release: os.release(),
                architecture: os.arch(),
                home_directory: os.homedir(),
                current_working_directory: process.cwd()
            };
        }
    }
};