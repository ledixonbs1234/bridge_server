# 📚 Hướng Dẫn Vận Hành & Kiến Trúc Dự Án: Bridge Server

Dự án **Bridge Server** là một Backend Node.js Engine đóng vai trò là trung tâm điều phối (Orchestrator) cho các Autonomous Developer Agents. Hệ thống được thiết kế để phân tích, lập kế hoạch và thực thi các tác vụ lập trình một cách an toàn, chính xác và dựa trên bằng chứng thực tế.

---

## 1. Tổng Quan Công Nghệ
- **Runtime**: Node.js (ES Modules - `"type": "module"`)
- **Web Framework**: Express.js (Port mặc định: `54321`)
- **AI Providers**: Hỗ trợ đa dạng (Qwen Web, DeepSeek Web, Gemini Studio, OpenAI, Claude, Ollama, v.v.) với cơ chế **Failover** tự động.
- **Cơ sở dữ liệu**: Mô phỏng SQLite dựa trên file JSON (`.agent_memory/agent_state.json`) để lưu trữ Memories, Pipelines, Traces và Telemetry.
- **Giao diện**: Static Web UI tại `/dashboard` và tích hợp Telegram Bot.

---

## 2. Kiến Trúc Hệ Thống

### 2.1. Entry Point (`server.js`)
- Khởi tạo Express server, cấu hình CORS và middleware.
- Cung cấp các endpoint chính:
  - `GET /health`: Kiểm tra trạng thái hệ thống, bộ nhớ, và số lượng skills đã nạp.
  - `POST /ask`: Endpoint tương thích cho WPF Desktop Assistant, hỗ trợ Streaming (SSE) và chế độ `isSimpleChat`.
  - `GET /api/skills`, `/api/system-prompt`: Cung cấp metadata cho frontend.
  - `/api/agent`, `/api/dashboard`, `/api/provider`: Các route xử lý logic nghiệp vụ.
- Khởi động Telegram Polling và CLI (nếu có cờ `--cli`).

### 2.2. Core Agent Service (`services/agentService.js`)
Là trái tim của hệ thống, xử lý vòng đời của một lượt tương tác (Agent Turn):
- **Context Switching**: Tự động phát hiện và chuyển đổi `globalThis.activeWorkspace` dựa trên đường dẫn trong tin nhắn.
- **Memory Retrieval (FluxMem)**: Sử dụng Vector Embedding (qua Ollama) và Cosine Similarity để truy xuất ký ức Episodic và Procedural một cách động (Dynamic Gating).
- **Query Reformulation**: Tối ưu hóa câu hỏi của người dùng trước khi đưa vào LLM.
- **Skill Execution**: Điều phối việc gọi các công cụ (Tools/Skills) với cơ chế ghi log, telemetry và xử lý lỗi.
- **Failover Mechanism**: Tự động chuyển sang provider dự phòng nếu provider chính gặp lỗi (tối đa 5 lần thử).

### 2.3. Skill Loader (`services/skillLoader.js`)
Quản lý và nạp động các khả năng của Agent:
- **Hard Skills**: Các file `.js` trong thư mục `skills/`, cung cấp các hàm thực thi cụ thể (đọc file, chạy terminal, tìm kiếm, v.v.).\n- **Soft Skills**: Các file `SKILL.md` trong `.agents/skills/`, cung cấp hướng dẫn quy trình (workflow) dưới dạng Markdown với Frontmatter YAML.
- **Hot Reload**: Tự động phát hiện thay đổi ở file `SKILL.md` và nạp lại mà không cần khởi động lại server.

### 2.4. Workflow Engine (`workflow_engine.js`)
- Đọc cấu hình Pipeline từ database (`pipelines` table).
- Sử dụng `DeclarativeGraphRunner` để thực thi các đồ thị trạng thái (State Graphs) một cách khai báo, phù hợp cho các tác vụ phức tạp nhiều bước.

### 2.5. Database Simulator (`database.js`)
- Mô phỏng các thao tác SQL (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) trên file JSON.
- Quản lý các thực thể: `memories`, `memory_edges`, `pipelines`, `agent_states`, `traces`, `trace_spans`, `tool_telemetry`, `agent_templates`.
- Tự động dọn dẹp các bản ghi memory bị lỗi/rỗng khi khởi động.

---

## 3. Quy Trình Làm Việc Chuẩn (ReAct Workflow)

Mọi tác vụ phải tuân thủ chu trình **Analyze → Act → Verify**:

1. **Analyze**: Đọc yêu cầu, xác định mục tiêu, kiểm tra xem đã có đủ dữ liệu (file, code, lỗi, output) chưa. Nếu chưa → Khảo sát thêm.
2. **Act**: Chỉ gọi Tool bằng JSON hợp lệ. Không đoán tên file, đường dẫn hoặc API. Luôn khảo sát workspace trước khi thao tác.
3. **Verify**: Phân tích kết quả thực tế sau mỗi hành động. Nếu lỗi → Tìm nguyên nhân gốc, không sửa kiểu thử vận may.

---

## 4. Quy Tắc Bắt Buộc (Mandatory Rules)

### 4.1. Git Isolation Protocol
**BẮT BUỘC** thực hiện trước khi sửa đổi bất kỳ file nào trong dự án có Git:
1. Chạy `git branch --show-current` để lưu nhánh hiện tại.
2. Chạy `git status --porcelain`. Nếu có thay đổi chưa commit → `git stash -u -m "agent-stash-temp"`.
3. Tạo nhánh tạm: `git checkout -b temp/fix-<tác-vụ>-<mã-ngẫu-nhiên>`.
4. Thực hiện thay đổi và chạy kiểm tra thực tế (build/test) trên nhánh tạm.
5. Commit thay đổi: `git add .` && `git commit -m "fix: <mô tả>"`.
6. Khôi phục trạng thái gốc: `git checkout <nhánh_gốc>` && `git stash pop` (nếu có stash).

### 4.2. Workspace & Anti-Hallucination
- Mọi thao tác file phải nằm trong `globalThis.activeWorkspace`.
- Tuyệt đối không giả định file, thư mục, API hoặc package tồn tại. Phải dùng tool (`list_directory`, `read_file`, `find_files`) để xác minh.
- Ưu tiên `write_file` cho file < 300 dòng, hoặc `replace_multiple_files_safe` cho nhiều file.

### 4.3. Terminal Safety
- **CẤM** sử dụng các lệnh giết tiến trình hàng loạt (`taskkill /F /IM node.exe`, `killall node`, `pkill node`).
- Các server chạy lâu phải được đặt `is_background: true`.
- Mọi lệnh terminal phải có mô tả `functionality` và `purpose` bằng tiếng Việt.

---

## 5. Cấu Hình & Môi Trường

- **File cấu hình chính**: `config.json`
  - `activeProvider`: Provider mặc định (hiện tại: `qwen-web`).
  - `providers`: Danh sách các provider được bật/tắt và thông tin xác thực.
  - `telegram`: Cấu hình Bot Token và Chat ID cho thông báo.
- **Biến môi trường**: Sử dụng file `.env` (tham khảo `.env.example`).
- **Cổng mặc định**: `54321` (Dashboard truy cập tại `http://localhost:54321/dashboard`).

---

## 6. Cấu Trúc Thư Mục Chính

| Thư mục / File | Mô tả |
| :--- | :--- |
| `server.js` | Điểm vào chính của ứng dụng Express. |
| `services/` | Chứa logic nghiệp vụ cốt lõi (`agentService`, `skillLoader`, `providerService`, `telegramService`). |
| `skills/` | Chứa các Hard Skills (`.js`) và thư mục con chứa Soft Skills (`SKILL.md`). |
| `graphs/` | Chứa các thành phần của Workflow Engine (`compiler`, `registry`, `runner`, `stateGraph`). |
| `providers/` | Các adapter kết nối với từng AI Provider (OpenAI, Claude, Ollama, Web-based, v.v.). |
| `routes/` | Các router của Express (`agent`, `dashboard`, `provider`). |
| `.agent_memory/` | (Tự động tạo) Lưu trữ sessions, memories, và file mô phỏng database (`agent_state.json`). |
| `system_prompt.md` | Prompt hệ thống gốc định nghĩa nguyên tắc hoạt động của Agent. |
| `instruction.md` | **File này** - Tài liệu hướng dẫn tổng quan kiến trúc và quy tắc. |

---

## 7. Hướng Dẫn Kiểm Thử & Xác Minh

- Sau khi sửa đổi code, luôn chạy kiểm tra thực tế nếu có thể (ví dụ: `npx tsc --noEmit` cho TypeScript, hoặc chạy script test liên quan).
- Khi thay đổi giao diện (UI), phải khởi chạy ứng dụng và sử dụng tool `capture_system_screenshot` để xác minh bằng chứng thực tế, không đánh giá bằng suy luận.
- Nếu độ chắc chắn thấp hoặc có ≥2 phương án hợp lý → **DỪNG LẠI** và sử dụng tool `ask_questions_if_underspecified` để hỏi người dùng.

> **Nguyên tắc vàng**: *Thà hỏi thêm một câu còn hơn sửa sai một file. Tool > Suy luận. Kết quả thực tế > Giả định.*
