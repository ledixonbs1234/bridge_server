// filepath: ridge_server/constants.js
/**
 * Constants and Configuration
 * Centralized constants to avoid magic numbers and hardcoded values
 */

// Timeouts (milliseconds)
export const HEARTBEAT_TIMEOUT_MS = 120000; // 2 minutes
export const SESSION_TIMEOUT_MINUTES = 120;
export const PERMISSION_TIMEOUT_MS = 300000; // 5 minutes
export const PROVIDER_RETRY_DELAY_MS = 1000;
export const SESSION_CLEANUP_INTERVAL_MS = 3600000; // 1 hour

// Retry configuration
export const MAX_PROVIDER_RETRIES = 5;

// Memory limits
export const MAX_LOG_BUFFER_SIZE = 1000; // Maximum log entries in buffer
export const MAX_PENDING_PERMISSIONS = 100;

// File system
export const MAX_SESSION_AGE_DAYS = 30;
export const MAX_REQUEST_SIZE = '10mb';

// Server
export const DEFAULT_PORT = 54321;

// Skill categories
export const SKILL_CATEGORIES = {
    CHAT: 'chat',
    CODE: 'code',
    RESEARCH: 'research',
    COMPLEX: 'complex'
};

// Skill groups mapping
export const SKILL_GROUPS = {
    [SKILL_CATEGORIES.CHAT]: [
        'read_file',
        'read_multiple_files',
        'write_file',
        'read_file_lines',
        'list_directory',
        'execute_terminal_command',
        'get_os_context',
        'memorize_rule',
        'find_files',
        'find_content',
        'google_search',
        'google_search_and_summarize',
        'parallel_web_summarizer',
        'capture_system_screenshot',
        'ask_questions_if_underspecified',
        'replace_content_safe',
        'replace_multiple_files_safe',
        'change_active_workspace',
        'debug_desktop_app'
    ],
    [SKILL_CATEGORIES.CODE]: [
        'run_automated_tests',
        'read_file',
        'read_multiple_files',
        'write_file',
        'replace_content_safe',
        'read_file_lines',
        'list_directory',
        'execute_terminal_command',
        'get_os_context',
        'stop_terminal_process',
        'memorize_rule',
        'replace_multiple_files_safe',
        'find_files',
        'find_content',
        'synthesize_skill',
        'google_search',
        'google_search_and_summarize',
        'parallel_web_summarizer',
        'capture_system_screenshot',
        'ask_questions_if_underspecified',
        'change_active_workspace',
        'debug_desktop_app',
        // TÍCH HỢP LSP GIAI ĐOẠN 2 VÀO NHÓM LẬP TRÌNH (CODE)
        'lsp_get_hover',
        'lsp_goto_definition',
        'lsp_find_references',
        'lsp_get_document_symbols',
        'lsp_rename_symbol',
        'lsp_get_code_actions',
        'lsp_apply_code_action'
    ],
    [SKILL_CATEGORIES.RESEARCH]: [
        'web_markdown_reader',
        'parallel_web_summarizer',
        'dynamic_browser_controller',
        'read_file',
        'replace_content_safe',
        'read_file_lines',
        'find_files',
        'find_content',
        'list_directory',
        'capture_system_screenshot',
        'execute_terminal_command',
        'get_os_context',
        'stop_terminal_process',
        'google_search',
        'google_search_and_summarize',
        'ask_questions_if_underspecified',
        'change_active_workspace',
        'debug_desktop_app',
        // TÍCH HỢP LSP GIAI ĐOẠN 2 VÀO NHÓM NGHIÊN CỨU (RESEARCH)
        'lsp_get_hover',
        'lsp_goto_definition',
        'lsp_get_document_symbols',
        'lsp_rename_symbol',
        'lsp_get_code_actions',
        'lsp_apply_code_action'
    ],
    [SKILL_CATEGORIES.COMPLEX]: null
};

// Log levels
export const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3
};

// Session types
export const SESSION_META_TYPE = '_type';
export const SESSION_FILE_PATTERN = /^session_.*\.jsonl$/;

// API routes
export const API_ROUTES = {
    HEALTH: '/health',
    DASHBOARD: '/api/dashboard',
    SESSIONS: '/api/dashboard/sessions',
    GOAL: '/api/dashboard/goal',
    PERMISSION: '/api/dashboard/permission',
    PIPELINE: '/api/dashboard/pipeline-state',
    PROVIDERS: '/api/providers',
    CHAT: '/api/chat'
};