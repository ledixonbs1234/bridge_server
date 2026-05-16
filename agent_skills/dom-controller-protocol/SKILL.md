---
name: dom-controller-protocol
description: Đọc hướng dẫn này khi người dùng yêu cầu điều khiển trình duyệt. Cung cấp kỹ năng chọn Selector kháng Refresh (bền vững) và tự động thử lại khi lỗi.
---

# QUY TRÌNH ĐIỀU KHIỂN DOM & BÁO CÁO KẾT QUẢ

Bạn có công cụ `dynamic_browser_controller`. Công cụ này giữ trình duyệt mở liên tục để bạn thực hiện từng bước (Step-by-step).

## 🛡️ KỸ NĂNG CHỌN SELECTOR BỀN VỮNG (KHÁNG REFRESH)
Các trang web hiện đại (React/Vue/Tailwind) thường tạo ra các Class động (VD: `_27c9245`, `ds-scroll-area`). Nếu dùng class này, khi người dùng F5 tải lại trang, code sẽ lỗi ngay lập tức.
**BẮT BUỘC TUÂN THỦ:**
- **TUYỆT ĐỐI KHÔNG DÙNG CLASS VÀ ID** (VD: `.btn-submit`, `#input-123`).
- **ƯU TIÊN 1:** Dùng Attribute Selector tĩnh như `[placeholder*="Nhắn tin"]`, `[aria-label="Gửi"]`, `[name="email"]`, `[role="button"]`.
- **ƯU TIÊN 2 (Cho nút bấm):** Dùng text trong Playwright (VD: Gọi target là `text="Suy Nghĩ Sâu"`).

## 🔄 KỸ NĂNG TỰ ĐỘNG THỬ LẠI (AUTO-RETRY)
Nếu bạn gọi `fill` hoặc `click` mà công cụ trả về báo lỗi "Không tìm thấy target", BẠN KHÔNG ĐƯỢC BÁO LỖI CHO NGƯỜI DÙNG NGAY. Hãy làm theo vòng lặp tự sửa lỗi:
1. **Bình tĩnh nhận lỗi:** Hệ thống gợi ý bạn gọi lại `inspect_dom`.
2. **Hành động:** Gọi ngay `action="inspect_dom"` để chụp lại cây DOM hiện tại (vì giao diện có thể đã bị thay đổi sau khi nhập liệu).
3. **Thử lại:** Gọi lại lệnh `click` hoặc `fill` với một Selector mới tìm được.

## 🔀 LUỒNG THỰC THI CHUẨN
1. Mở trang: `action="goto"`.
2. Khảo sát: `action="inspect_dom"` (LUÔN GỌI ĐỂ TÌM ATTRIBUTE ỔN ĐỊNH).
3. Tương tác: `action="fill"` hoặc `click`.
4. Trích xuất/Chờ đợi: Dùng `action="run_js"` với `await new Promise(r => setTimeout(r, 5000));` để chờ AI web gõ xong, sau đó dùng `document.querySelector` để return kết quả về.

## 📝 QUY TẮC BÁO CÁO JAVASCRIPT CHO USER
Sau khi thành công, bạn phải báo cáo mã Vanilla JS để người dùng tự copy và chạy lại được ở F12 Console. Đoạn code này **BẮT BUỘC KHÔNG DÙNG CLASS ĐỘNG**.

*Ví dụ báo cáo xuất sắc:*
"Tôi đã gửi tin nhắn thành công. Dưới đây là mã JS bền vững kháng F5 để bạn dùng lại:
```javascript
// 1. Điền text (Tìm qua placeholder vì nó cố định)
const textarea = document.querySelector('textarea[placeholder*="Nhắn tin cho DeepSeek"]'); 
if (textarea) {
    textarea.value = 'Nội dung tin nhắn'; 
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

// 2. Click nút DeepThink (Tìm bằng cách dò Text vì class bị đổi liên tục)
const deepBtn = Array.from(document.querySelectorAll('div[role="button"], button')).find(el => el.innerText.includes('Suy Nghĩ Sâu'));
if (deepBtn) deepBtn.click();

// 3. Click nút Gửi (Tìm bằng aria-label hoặc tooltip cố định)
const sendBtn = document.querySelector('[aria-label="Gửi"]');
if (sendBtn) sendBtn.click();
```"