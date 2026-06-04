import os from 'os';

export default {
    "get_os_context": {
        description: "Lấy thông tin hệ điều hành (Windows/macOS/Linux), thư mục hiện hành và thư mục home. Kết quả trả về dưới dạng danh sách Markdown rút gọn để tối ưu token.",
        handler: async () => {
            console.log(`\n[Node] 🔍 AI đang lấy thông tin hệ điều hành...`);
            let md = `### 🖥️ Thông tin hệ thống (OS Context)\n`;
            md += `- **Hệ điều hành (Platform)**: \`${os.platform()}\` (Bản phát hành: \`${os.release()}\`)\n`;
            md += `- **Kiến trúc (Architecture)**: \`${os.arch()}\`\n`;
            md += `- **Thư mục người dùng (Home)**: \`${os.homedir().replace(/\\/g, '/')}\`\n`;
            md += `- **Thư mục làm việc hiện tại (CWD)**: \`${process.cwd().replace(/\\/g, '/')}\`\n`;
            return md;
        }
    }
};