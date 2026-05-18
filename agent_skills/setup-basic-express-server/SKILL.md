---
name: setup-basic-express-server
description: Quy trình khởi tạo và chạy một ứng dụng Express.js cơ bản từ đầu.
---

### Mục tiêu: Thiết lập nhanh một server Express.js để kiểm thử.

### Các bước thực hiện:
1. **Khởi tạo dự án:**
   - Di chuyển vào thư mục dự án.
   - Chạy: `npm init -y`
2. **Cài đặt thư viện:**
   - Chạy: `npm install express`
3. **Tạo file code (`index.js`):**
   - Nội dung bao gồm: require express, khởi tạo app, định nghĩa route `/`, và `app.listen`.
4. **Chạy server:**
   - Dùng `execute_terminal_command` với tham số `is_background: true`.
   - Lệnh: `node index.js`
5. **Kiểm tra và Dọn dẹp:**
   - Sau khi kiểm tra xong qua log hoặc ping, sử dụng `stop_terminal_process` với `process_id` tương ứng để giải phóng port.

### Lưu ý:
- Luôn sử dụng `is_background: true` cho lệnh chạy server để tránh treo tiến trình.
- Đảm bảo dừng server sau khi hoàn thành để tránh lỗi 'Port already in use' cho các lần chạy sau.
