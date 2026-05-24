/**
 * Global State Management
 * Định nghĩa các biến toàn cục dùng chung cho toàn bộ ứng dụng
 * Tránh sử dụng globalThis trực tiếp rải rác để dễ kiểm soát hơn
 */

// Lưu trữ Provider đang hoạt động (Gemini, OpenAI, etc.)
export let activeProvider = null;

// Hàm xin phép thực thi action (dùng cho Web Chat UI)
export let askPermission = null;

// Hàm ghi log ra Web Chat
export let logToWebChat = null;

// Setter helpers
export function setActiveProvider(provider) {
    activeProvider = provider;
}

export function setAskPermission(fn) {
    askPermission = fn;
}

export function setLogToWebChat(fn) {
    logToWebChat = fn;
}

// Đồng bộ với global object của Node.js để tương thích với các module cũ
if (typeof global !== 'undefined') {
    Object.defineProperty(global, 'activeProvider', {
        get() { return activeProvider; },
        set(val) { activeProvider = val; }
    });
    Object.defineProperty(global, 'askPermission', {
        get() { return askPermission; },
        set(val) { askPermission = val; }
    });
    Object.defineProperty(global, 'logToWebChat', {
        get() { return logToWebChat; },
        set(val) { logToWebChat = val; }
    });
}

export default {
    get activeProvider() { return activeProvider; },
    set activeProvider(val) { 
        activeProvider = val; 
        if (typeof global !== 'undefined') global.activeProvider = val; 
    },
    
    get askPermission() { return askPermission; },
    set askPermission(val) { 
        askPermission = val; 
        if (typeof global !== 'undefined') global.askPermission = val; 
    },
    
    get logToWebChat() { return logToWebChat; },
    set logToWebChat(val) { 
        logToWebChat = val; 
        if (typeof global !== 'undefined') global.logToWebChat = val; 
    }
};
