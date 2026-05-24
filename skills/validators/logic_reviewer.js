// skills/validators/logic_reviewer.js
import chalk from 'chalk';

/**
 * Dùng Subagent (LLM) để review logic của code change
 * @param {object} options.provider - Provider để gọi LLM
 * @param {string} options.filePath - Đường dẫn file
 * @param {string} options.originalContext - Context gốc (±20 dòng)
 * @param {string} options.newCode - Code mới được chèn
 * @param {string} options.fullNewContent - Toàn bộ file sau khi sửa
 * @param {string} options.taskDescription - Mô tả task AI đang làm
 * @returns {{ verdict: 'PASS'|'FAIL'|'WARN', issues: string[], suggestion?: string }}
 */
export async function reviewLogicChange({ 
  provider, filePath, originalContext, newCode, 
  fullNewContent, taskDescription 
}) {
  const language = detectLanguage(filePath);
  
  const reviewPrompt = `Bạn là một Senior Code Reviewer cực kỳ khắt khe. Hãy review THAY ĐỔI CODE sau và phát hiện LỖI LOGIC (không phải lỗi style).

📂 FILE: ${filePath}
🎯 NHIỆM VỤ AI ĐANG LÀM: ${taskDescription || '(không rõ)'}

═══════════════════════════════════════════════
📜 CONTEXT GỐC (trước khi sửa):
═══════════════════════════════════════════════
${originalContext}

═══════════════════════════════════════════════
✨ CODE MỚI (sẽ thay thế vùng trên):
═══════════════════════════════════════════════
${newCode}

═══════════════════════════════════════════════
🔍 TOÀN BỘ FILE SAU KHI SỬA (để check context):
═══════════════════════════════════════════════
${fullNewContent.substring(0, 15000)}${fullNewContent.length > 15000 ? '\n...[cắt bớt]' : ''}

HÃY KIỂM TRA CÁC LỖI SAU:
1. ❌ Biến được dùng nhưng KHÔNG được khai báo/import
2. ❌ Function được gọi nhưng KHÔNG tồn tại hoặc SAI signature
3. ❌ Import/Export không khớp (import cái không export, export thiếu)
4. ❌ Logic mâu thuẫn với phần còn lại của file
5. ❌ Duplicate code / duplicate function definition
6. ❌ Xóa nhầm code quan trọng (validation, error handling, security check)
7. ❌ Scope sai (biến trong block được dùng ngoài block)
8. ❌ Async/await bị thiếu hoặc sai
9. ❌ Type mismatch rõ ràng

📋 FORMAT TRẢ LỜI (BẮT BUỘC JSON):
\`\`\`json
{
  "verdict": "PASS" hoặc "FAIL" hoặc "WARN",
  "issues": ["mô tả lỗi 1", "mô tả lỗi 2"],
  "suggestion": "gợi ý sửa nếu FAIL (optional)"
}
\`\`\`

Quy tắc:
- PASS = không tìm thấy lỗi logic nào
- WARN = có vấn đề tiềm ẩn nhưng không chắc chắn là lỗi
- FAIL = có lỗi logic rõ ràng, KHÔNG được apply

Chỉ trả về JSON, không giải thích thêm.`;

  try {
    console.log(chalk.blue(`🤖 [Subagent] Đang review logic cho: ${filePath}`));
    
    const response = await provider.chat({
      messages: [{ role: 'user', content: reviewPrompt }],
      skillRegistry: {},
      executeSkill: async () => {},
      systemPrompt: "Bạn là Code Reviewer. Chỉ trả về JSON hợp lệ.",
      maxSteps: 1,
      isWorker: true,
      workerType: 'code_reviewer'
    });
    
    // Parse JSON từ response
    const cleaned = response.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { verdict: 'WARN', issues: ['Không parse được kết quả review'], raw: response };
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      verdict: parsed.verdict || 'PASS',
      issues: parsed.issues || [],
      suggestion: parsed.suggestion || null
    };
  } catch (err) {
    console.warn(chalk.yellow(`[Subagent] Review lỗi: ${err.message}`));
    return { verdict: 'WARN', issues: [`Subagent error: ${err.message}`] };
  }
}

function detectLanguage(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  const map = {
    js: 'JavaScript', jsx: 'React JSX', ts: 'TypeScript', tsx: 'React TSX',
    py: 'Python', java: 'Java', cs: 'C#', cpp: 'C++', c: 'C',
    go: 'Go', rs: 'Rust', rb: 'Ruby', php: 'PHP',
    html: 'HTML', css: 'CSS', scss: 'SCSS',
    json: 'JSON', yaml: 'YAML', yml: 'YAML', md: 'Markdown'
  };
  return map[ext] || ext.toUpperCase();
}

export default { reviewLogicChange };