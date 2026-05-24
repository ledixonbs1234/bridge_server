// skills/validators/shadow_file.js
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const SHADOW_DIR = path.join(process.cwd(), '.agent_memory', 'shadows');

if (!fs.existsSync(SHADOW_DIR)) {
  fs.mkdirSync(SHADOW_DIR, { recursive: true });
}

/**
 * Chụp snapshot file trước khi sửa
 * @returns {{ shadowId: string, shadowPath: string, restore: Function }}
 */
export function createShadow(originalPath) {
  const shadowId = randomUUID();
  const safeName = path.basename(originalPath).replace(/[^a-z0-9.-]/gi, '_');
  const shadowPath = path.join(SHADOW_DIR, `${shadowId}_${safeName}`);
  
  let hadOriginal = false;
  if (fs.existsSync(originalPath)) {
    fs.copyFileSync(originalPath, shadowPath);
    hadOriginal = true;
  }
  
  return {
    shadowId,
    shadowPath,
    hadOriginal,
    restore: () => {
      if (hadOriginal && fs.existsSync(shadowPath)) {
        fs.copyFileSync(shadowPath, originalPath);
        console.log(`[Shadow] ↩️  Đã rollback file: ${originalPath}`);
        return true;
      } else if (!hadOriginal && fs.existsSync(originalPath)) {
        fs.unlinkSync(originalPath);
        console.log(`[Shadow] 🗑️  Đã xóa file mới tạo: ${originalPath}`);
        return true;
      }
      return false;
    },
    cleanup: () => {
      try { fs.unlinkSync(shadowPath); } catch {}
    }
  };
}

/**
 * Tự động dọn các shadow cũ (>24h)
 */
export function cleanupOldShadows(maxAgeHours = 24) {
  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  
  try {
    const files = fs.readdirSync(SHADOW_DIR);
    let cleaned = 0;
    for (const f of files) {
      const fp = path.join(SHADOW_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(fp);
        cleaned++;
      }
    }
    return cleaned;
  } catch { return 0; }
}