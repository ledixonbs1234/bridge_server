---
name: dom-controller-protocol
description: Đọc hướng dẫn này khi người dùng yêu cầu điều khiển trình duyệt (điền form, bấm nút, lấy dữ liệu, thao tác web chat).
---

# QUY TRÌNH ĐIỀU KHIỂN DOM & BÁO CÁO KẾT QUẢ

Bạn có công cụ `dynamic_browser_controller`. Công cụ này giữ trình duyệt mở liên tục. Đối với các tác vụ phức tạp (như nhắn tin cho AI khác, checkout giỏ hàng), bạn BẮT BUỘC phải gọi công cụ này nhiều lần theo từng bước (Step-by-step).

## 🔀 LUỒNG THỰC THI CHUẨN
1. **Bước 1 (Mở trang):** Gọi `action="goto"` với URL tương ứng.
2. **Bước 2 (Dò tìm Selector):** ĐỪNG ĐOÁN MÒ CSS SELECTOR! Hãy gọi `action="inspect_dom"` để hệ thống trả về danh sách các phần tử tương tác (button, input, textarea) đang có mặt trên trang.
3. **Bước 3 (Tương tác):** 
   - Dùng `action="fill"` với Selector tìm được để điền text.
   - Dùng `action="click"` để bấm nút (VD: Bấm nút Gửi/Send).
4. **Bước 4 (Trích xuất / Chờ đợi):** 
   - Nếu trang web cần thời gian để gen dữ liệu (như DeepSeek/ChatGPT đang gõ câu trả lời), hãy dùng `action="run_js"` và viết mã JS có chứa `await new Promise(r => setTimeout(r, 5000));` để chờ, sau đó `return document.querySelector('...').innerText;` để lấy kết quả.
5. **Bước 5 (Đóng):** Gọi `action="close"` để dọn dẹp.

## 📝 QUY TẮC BÁO CÁO CHO NGƯỜI DÙNG (QUAN TRỌNG)
Sau khi thực hiện THÀNH CÔNG toàn bộ yêu cầu, câu trả lời cuối cùng của bạn gửi cho người dùng **BẮT BUỘC** phải có cấu trúc sau:

1. **Trạng thái:** Thành công hay Thất bại (Kèm theo kết quả lấy được nếu có).
2. **Mã JavaScript tương đương:** Liệt kê các lệnh JavaScript thuần (Vanilla JS) có thể dùng để thực hiện lại thao tác này trên Console của trình duyệt. 

*Ví dụ báo cáo chuẩn:*
"Tôi đã gửi tin nhắn thành công và lấy được kết quả: [Nội dung AI trả lời].
Dưới đây là các lệnh JavaScript tương đương tôi đã sử dụng:
```javascript
// Điền nội dung
document.querySelector('#chat-input').value = 'Nội dung tin nhắn';
document.querySelector('#chat-input').dispatchEvent(new Event('input', { bubbles: true }));

// Bấm nút gửi
document.querySelector('.send-button-class').click();
```"