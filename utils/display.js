// ridge_server/utils/display.js
import boxen from 'boxen';
import chalk from 'chalk';

/**
 * Trực quan hóa yêu cầu phê duyệt trên cả Terminal và Web UI một cách độc lập
 */
export function presentApprovalRequest(title, details, rawData) {
    // 1. Định dạng văn bản có màu sắc dành cho CLI Terminal
    const promptContent = `
${chalk.bold.yellow('📂 File :')} ${details.file_path || 'N/A'}
${chalk.bold.yellow('📍 Phạm vi :')} ${details.range || 'N/A'}
${chalk.bold.green('🔧 Chức năng:')} ${details.functionality || 'Sửa đổi cấu trúc'}
`;

    // Sử dụng console gốc (tránh bộ bắt log của Web UI) để in ra Terminal
    const terminalLogger = global.originalConsoleLog || console.log;
    
    terminalLogger(boxen(promptContent, {
        title: title,
        padding: 1, 
        borderColor: 'yellow', 
        borderStyle: 'round'
    }));

    // 2. Nếu có phiên Web đang hoạt động, gửi gói tin JSON thô cho trình duyệt qua SSE
    if (typeof global.logToWebChat === 'function') {
        global.logToWebChat(JSON.stringify({
            type: 'APPROVAL_REQUEST',
            title: title,
            details: details,
            rawData: rawData
        }));
    }
}