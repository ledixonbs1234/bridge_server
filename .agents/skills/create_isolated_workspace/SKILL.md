---
name: create_isolated_workspace
description: Tạo một workspace cách ly bằng git worktree để đảm bảo an toàn cho dự án gốc của User khi thực hiện task mới.
---

# Create Isolated Workspace

## Context
Tool này giúp AI tạo ra một môi trường làm việc độc lập (isolated workspace) thay vì code trực tiếp trên thư mục hiện hành (cwd). Bằng cách dùng `git worktree`, AI có thể thao tác (chỉnh sửa, test, commit) thoải mái mà không lo ảnh hưởng đến source code đang dang dở của user, và dễ dàng dọn dẹp nếu có lỗi.

## Requirements
- Dự án hiện hành phải là một Git repository hợp lệ.
- Có khả năng chạy các lệnh terminal.

## Instructions
Khi được yêu cầu bắt đầu một task mới có tính chất phức tạp hoặc có nguy cơ làm hỏng code hiện tại, hãy sử dụng skill này:

1. **Sinh tên nhánh và thư mục**:
   - Dựa vào tên task, hãy tạo một định danh phù hợp (ví dụ: `task-123` hoặc `feature-login`).
   - Tên nhánh (branch): `feature/<tên-task>`
   - Đường dẫn thư mục (worktree path): `../archon-<tên-task>` (đặt ở cấp cao hơn thư mục dự án hiện hành một bậc để cách ly hoàn toàn).

2. **Tạo worktree**:
   - Chạy lệnh sau trong terminal tại thư mục dự án gốc (cwd):
     ```bash
     git worktree add ../archon-<tên-task> -b feature/<tên-task>
     ```
   - *Lưu ý*: Nếu nhánh đã tồn tại, có thể bỏ cờ `-b` hoặc xử lý tên nhánh khác cho khỏi trùng lặp.

3. **Chuyển đổi Working Directory**:
   - Bắt đầu từ bây giờ, MỌI thao tác tiếp theo bao gồm:
     - Đọc file (`read_file`, `view_file`)
     - Ghi/sửa file (`write_file`, `replace_file_content`, `multi_replace_file_content`)
     - Chạy lệnh terminal (`run_command`, `execute_terminal_command`, bao gồm cả start server, run test...)
   - Đều phải sử dụng thư mục mới: `../archon-<tên-task>` (hãy dùng đường dẫn tuyệt đối của thư mục này để tránh nhầm lẫn).

4. **Báo cáo hoàn tất**:
   - Sau khi thiết lập xong worktree và chuyển context thành công, hãy báo cáo lại với người dùng:
     "Đã tạo xong nhánh feature/<tên-task> và chuyển sang workspace cách ly."
   - AI có thể tiếp tục thực thi các bước của task trên thư mục mới này trong background mà không lo ảnh hưởng đến tiến độ của người dùng.

5. **Gộp Code và Dọn Dẹp (Merge & Cleanup)**:
   - Khi công việc trên nhánh `feature/<tên-task>` hoàn tất và User xác nhận code chạy ổn, hãy thực hiện các bước sau để áp dụng vào dự án gốc:
     1. Ghi lại các thay đổi vào nhánh feature: `git add . && git commit -m "feat: hoàn thành task <tên-task>"` (thực hiện tại thư mục worktree).
     2. Quay lại thư mục dự án gốc (cwd ban đầu).
     3. Gộp nhánh vừa tạo vào nhánh hiện tại của user: `git merge feature/<tên-task>`.
     4. Dọn dẹp worktree: `git worktree remove ../archon-<tên-task>` (lệnh này sẽ xóa thư mục cách ly một cách an toàn).
     5. Xóa nhánh feature nếu không còn cần thiết: `git branch -d feature/<tên-task>`.
   - Thông báo cho User biết rằng mọi thứ đã được gộp thành công vào source gốc và môi trường làm việc đã được dọn dẹp sạch sẽ.

## Example Workflow
1. User yêu cầu: "Hãy viết thêm tính năng đăng nhập cho server."
2. AI nghĩ: Đây là một thay đổi lớn, cần tạo isolated workspace.
3. AI sinh tên task: `feature-login`.
4. AI chạy: `git worktree add ../archon-feature-login -b feature/feature-login` tại thư mục hiện hành.
5. AI nhận diện đường dẫn thư mục mới, ví dụ: `h:\DATA\NODEJS\archon-feature-login`.
6. Tự nhắc nhở bản thân dùng đường dẫn này cho mọi tool đọc/ghi/chạy lệnh.
7. Output cho User: "Đã tạo xong nhánh feature/feature-login và chuyển sang workspace cách ly. Tôi sẽ bắt đầu làm việc trên thư mục này."
