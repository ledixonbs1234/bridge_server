// =================================================================
// 🛡️ PATH GUARD - Bảo vệ chống Path Traversal & truy cập file nhạy cảm
// =================================================================
import path from 'path';
import os from 'os';
import fs from 'fs';
import chalk from 'chalk';

/**
 * Danh sách WHITELIST - Các thư mục AI được phép truy cập
 * Path phải nằm TRONG (hoặc là con của) một trong các thư mục này
 */
const ALLOWED_ROOTS = [
  // Thư mục cá nhân của user
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'Downloads'),
  path.join(os.homedir(), 'Pictures'),
  path.join(os.homedir(), 'Videos'),
  path.join(os.homedir(), 'Music'),
  path.join(os.homedir() ),
  
  // Project hiện tại
  process.cwd(),
  
  // Cho phép thư mục tmp của user (không phải /tmp hệ thống)
  path.join(os.homedir(), 'tmp'),
  path.join(os.homedir(), '.tmp'),
];

/**
 * Danh sách BLACKLIST - Các thư mục hệ thống TUYỆT ĐỐI KHÔNG cho phép
 * Ngay cả khi nằm trong whitelist (ví dụ symlink attack)
 */
const FORBIDDEN_PATHS = [
  // Windows system
  'C:/Windows',
  'C:/Program Files',
  'C:/Program Files (x86)',
  'C:/ProgramData',
  'C:/$Recycle.Bin',
  'C:/System Volume Information',
  
  // Unix/Linux system
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/var',
  '/sys',
  '/proc',
  '/boot',
  '/dev',
  '/lib',
  '/lib64',
  '/root',
  '/tmp',      // /tmp hệ thống (khác với ~/tmp của user)
  
  // macOS system
  '/System',
  '/Library',
  '/Applications',
  '/private',
  
  // Sensitive files (exact match)
  '/etc/passwd',
  '/etc/shadow',
  '/etc/hosts',
  'C:/Windows/System32/config/SAM',
];

/**
 * Danh sách BLACKLIST file extensions - File nhạy cảm
 */
const FORBIDDEN_EXTENSIONS = [
  '.pem', '.key', '.p12', '.pfx',           // Private keys
  '.keystore', '.jks',                       // Java keystores
  'id_rsa', 'id_dsa', 'id_ed25519',         // SSH keys
  '.env.local', '.env.production',           // Production env (cho phép .env dev)
  'credentials.json',                        // Google/AWS credentials
  '.aws/credentials',                        // AWS credentials
  'authorized_keys',                         // SSH authorized keys
];

/**
 * Normalize path để so sánh nhất quán
 */
function normalizePath(p) {
  return path.resolve(p).replace(/\\/g, '/');
}

/**
 * Kiểm tra path có nằm trong một root hay không
 */
function isPathInside(childPath, parentPath) {
  const normalizedChild = normalizePath(childPath);
  const normalizedParent = normalizePath(parentPath);
  
  // Path phải bắt đầu bằng parent + "/" (hoặc bằng chính parent)
  return normalizedChild === normalizedParent ||
         normalizedChild.startsWith(normalizedParent + '/');
}

/**
 * Phân tích và validate path
 * @param {string} inputPath - Path đầu vào từ AI
 * @returns {{ allowed: boolean, resolved?: string, reason?: string, level?: 'safe'|'warn'|'danger' }}
 */
export function validatePath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    return {
      allowed: false,
      level: 'danger',
      reason: 'Path không hợp lệ (rỗng hoặc không phải string)'
    };
  }
  
  // Xử lý shortcut "desktop"
  if (inputPath.toLowerCase() === 'desktop') {
    const desktopPath = path.join(os.homedir(), 'Desktop');
    return { allowed: true, resolved: normalizePath(desktopPath), level: 'safe' };
  }
  
  // Resolve về absolute path
  let resolved;
  try {
    // Nếu là relative path, resolve từ cwd
    resolved = path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(process.cwd(), inputPath);
  } catch (e) {
    return {
      allowed: false,
      level: 'danger',
      reason: `Không thể resolve path: ${e.message}`
    };
  }
  
  const normalizedResolved = normalizePath(resolved);
  
  // 1. Check BLACKLIST exact paths
  for (const forbidden of FORBIDDEN_PATHS) {
    const normalizedForbidden = normalizePath(forbidden);
    if (normalizedResolved === normalizedForbidden ||
        normalizedResolved.startsWith(normalizedForbidden + '/')) {
      return {
        allowed: false,
        level: 'danger',
        reason: `Path nằm trong vùng cấm hệ thống: ${forbidden}`,
        resolved: normalizedResolved
      };
    }
  }
  
  // 2. Check BLACKLIST file extensions/names
  const fileName = path.basename(normalizedResolved).toLowerCase();
  for (const forbiddenExt of FORBIDDEN_EXTENSIONS) {
    if (fileName.endsWith(forbiddenExt.toLowerCase()) ||
        fileName === forbiddenExt.toLowerCase()) {
      return {
        allowed: false,
        level: 'warn',
        reason: `File nhạy cảm không được phép truy cập: ${fileName}`,
        resolved: normalizedResolved
      };
    }
  }
  
  // 3. Check WHITELIST - path phải nằm trong một allowed root
  const isAllowed = ALLOWED_ROOTS.some(root => isPathInside(resolved, root));
  
  if (!isAllowed) {
    return {
      allowed: false,
      level: 'warn',
      reason: `Path nằm ngoài vùng cho phép. Các thư mục được phép:\n  - ${ALLOWED_ROOTS.join('\n  - ')}`,
      resolved: normalizedResolved
    };
  }
  
  return {
    allowed: true,
    resolved: normalizedResolved,
    level: 'safe'
  };
}

/**
 * In cảnh báo path bị chặn
 */
export function printPathWarning(validation, inputPath) {
  if (validation.level === 'danger') {
    console.log(chalk.red.bold(`
╔══════════════════════════════════════════════════════════╗`));
    console.log(chalk.red.bold(`║  🚨 BLOCKED: PATH BỊ CHẶN VÌ LÝ DO BẢO MẬT              ║`));
    console.log(chalk.red.bold(`╚══════════════════════════════════════════════════════════╝`));
    console.log(chalk.yellow(`Input:   `) + chalk.white(inputPath));
    console.log(chalk.yellow(`Resolved:`) + chalk.white(validation.resolved || 'N/A'));
    console.log(chalk.yellow(`Lý do:   `) + chalk.red(validation.reason));
  } else if (validation.level === 'warn') {
    console.log(chalk.yellow(`
⚠️  Path bị chặn: ${chalk.white(inputPath)}`));
    console.log(chalk.gray(`   Lý do: ${validation.reason}`));
  }
}

/**
 * Thêm thư mục vào whitelist (dùng cho plugin mở rộng)
 * @param {string} newRoot - Đường dẫn thư mục mới
 */
export function addAllowedRoot(newRoot) {
  const normalized = normalizePath(newRoot);
  if (!ALLOWED_ROOTS.includes(normalized)) {
    ALLOWED_ROOTS.push(normalized);
    console.log(chalk.green(`[PathGuard] ✅ Đã thêm vào whitelist: ${normalized}`));
  }
}

/**
 * Lấy danh sách allowed roots hiện tại (cho debug)
 */
export function getAllowedRoots() {
  return [...ALLOWED_ROOTS];
}

export default {
  validatePath,
  printPathWarning,
  addAllowedRoot,
  getAllowedRoots,
  ALLOWED_ROOTS,
  FORBIDDEN_PATHS,
  FORBIDDEN_EXTENSIONS
};