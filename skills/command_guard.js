// =================================================================
// 🛡️ COMMAND GUARD - Bảo vệ chống Command Injection
// =================================================================
import chalk from 'chalk';

// Danh sách các pattern nguy hiểm (case-insensitive)
const DANGEROUS_PATTERNS = [
  // Windows dangerous commands
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?([a-zA-Z]:\\|\/|\.\.|~)\b/i,  // rm -rf with dangerous paths
  /\bformat\s+[a-zA-Z]:/i,                                         // format C:
  /\bdel\s+\/[sS]\b/,                                              // del /s (recursive delete)
  /\brmdir\s+\/[sS]\b/,                                            // rmdir /s
  /\bshutdown\b/i,                                                  // shutdown
  /\brestart\b/i,                                                   // restart
  /\bsfc\s+\/scannow\b/i,                                          // system file checker
  /\bbcdedit\b/i,                                                  // boot config
  /\breg\s+delete\b/i,                                             // registry delete
  /\bnet\s+user\b/i,                                               // user management
  /\bnetsh\s+advfirewall\s+reset\b/i,                              // firewall reset
  
  // Unix/Linux dangerous commands
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\//i,                  // rm -rf /
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+~\b/i,                 // rm -rf ~
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\.\./i,                // rm -rf ..
  /\bmkfs\./i,                                                      // format disk
  /\bdd\s+if=.*of=\/dev\/[sh]d/i,                                  // overwrite disk
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/,                            // fork bomb
  /\bchmod\s+-R\s+777\s+\//i,                                      // chmod 777 /
  /\bchown\s+-R\b.*\s+\/\b/i,                                      // chown -R /
  /\bwget\b.*\|\s*(ba)?sh\b/i,                                     // wget | sh
  /\bcurl\b.*\|\s*(ba)?sh\b/i,                                     // curl | sh
  
  // Cross-platform dangerous
  />\s*\/dev\/[sh]d[a-z]/i,                                        // overwrite disk
  /\bpython\b.*-c\b.*import\s+os\b.*system\b/i,                    // python os.system
  /\bnode\b.*-e\b.*require\('child_process'\)/i,                   // node exec
  /\bpowershell\b.*-enc(oded)?command\b/i,                         // encoded powershell
];

// Commands cần xin phép trước khi chạy (không block hẳn)
const ASK_CONFIRMATION_PATTERNS = [
  /\bnpm\s+uninstall\s+-g\b/i,                                     // global uninstall
  /\bpip\s+uninstall\b/i,                                          // pip uninstall
  /\bgit\s+push\s+--force\b/i,                                     // force push
  /\bgit\s+reset\s+--hard\b/i,                                     // hard reset
  /\bDROP\s+(TABLE|DATABASE)\b/i,                                  // SQL drop
  /\bTRUNCATE\b/i,                                                  // SQL truncate
  /\bkubectl\s+delete\b/i,                                         // k8s delete
  /\bdocker\s+(rm|rmi)\b/i,                                        // docker rm
];

// Commands an toàn - tự động approve (không cần hỏi user)
const SAFE_COMMANDS = [
  /^dir\s+/i,                                                       // Windows list dir
  /^ls\s*/i,                                                        // Unix list dir
  /^echo\s+/i,                                                      // echo text
  /^pwd$/i,                                                         // print working directory
  /^cd\s+/i,                                                        // change directory
  /^cat\s+/i,                                                       // view file content
  /^type\s+/i,                                                      // Windows view file
  /^test\s+/i,                                                      // test command
  /^\[.*\]$/i,                                                      // bash test
];

// Timeout mặc định cho các command (ms)
const DEFAULT_TIMEOUT = 60000;       // 60 giây
const BACKGROUND_TIMEOUT = 300000;   // 5 phút cho background process

/**
 * Kiểm tra mức độ nguy hiểm của command
 * @param {string} command - Command cần kiểm tra
 * @returns {{ level: 'safe'|'warn'|'danger', reason?: string, pattern?: string }}
 */
export function analyzeCommand(command) {
  if (!command || typeof command !== 'string') {
    return { level: 'safe' };
  }
  
  const normalizedCmd = command.trim();
  
  // Check safe commands (AUTO-APPROVE)
  for (const pattern of SAFE_COMMANDS) {
    if (pattern.test(normalizedCmd)) {
      return { level: 'safe' };
    }
  }
  
  // Check dangerous patterns (BLOCK)
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(normalizedCmd)) {
      return {
        level: 'danger',
        reason: `Command chứa pattern nguy hiểm`,
        pattern: pattern.toString()
      };
    }
  }
  
  // Check confirmation-required patterns (ASK)
  for (const pattern of ASK_CONFIRMATION_PATTERNS) {
    if (pattern.test(normalizedCmd)) {
      return {
        level: 'warn',
        reason: `Command cần xác nhận trước khi chạy`,
        pattern: pattern.toString()
      };
    }
  }
  
  return { level: 'safe' };
}

/**
 * In cảnh báo đẹp ra terminal
 */
export function printCommandWarning(analysis, command) {
  if (analysis.level === 'danger') {
    console.log(chalk.red.bold(`
╔══════════════════════════════════════════════════════════╗`));
    console.log(chalk.red.bold(`║  🚨 BLOCKED: COMMAND NGUY HIỂM BỊ CHẶN                  ║`));
    console.log(chalk.red.bold(`╚══════════════════════════════════════════════════════════╝`));
    console.log(chalk.yellow(`Command: `) + chalk.white(command));
    console.log(chalk.yellow(`Lý do:   `) + chalk.white(analysis.reason));
    console.log(chalk.gray(`Pattern: ${analysis.pattern}`));
  } else if (analysis.level === 'warn') {
    console.log(chalk.yellow(`
⚠️  Command cần xác nhận: ${chalk.white(command)}`));
    console.log(chalk.gray(`   Lý do: ${analysis.reason}`));
  }
}

/**
 * Lấy timeout phù hợp cho command
 */
export function getCommandTimeout(command, isBackground = false) {
  if (isBackground) return BACKGROUND_TIMEOUT;
  
  // Một số commands cần timeout dài hơn
  if (/npm\s+install|yarn\s+install|pnpm\s+install/i.test(command)) {
    return 300000; // 5 phút cho install
  }
  if (/npm\s+run\s+build|next\s+build|webpack/i.test(command)) {
    return 180000; // 3 phút cho build
  }
  if (/pytest|jest|mocha/i.test(command)) {
    return 120000; // 2 phút cho test
  }
  
  return DEFAULT_TIMEOUT;
}

export default {
  analyzeCommand,
  printCommandWarning,
  getCommandTimeout,
  DANGEROUS_PATTERNS,
  ASK_CONFIRMATION_PATTERNS,
  SAFE_COMMANDS
};