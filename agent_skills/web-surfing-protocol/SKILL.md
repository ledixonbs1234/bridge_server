---
name: web-surfing-protocol
description: Đọc sổ tay hướng dẫn này ĐẦU TIÊN khi bạn cần lướt web, đọc tài liệu online hoặc tìm kiếm thông tin trên mạng.
---
# QUY TRÌNH LƯỚT WEB VÀ TÌM KIẾM CỦA AGENT

Bạn được trang bị 2 công cụ làm việc với Web: `web_markdown_reader` (Ưu tiên dùng) và `browser_action` (Hạn chế dùng).

## 1. NGUYÊN TẮC TỐI ƯU TOKEN (BẮT BUỘC)
- Nếu bạn CHỈ CẦN tìm kiếm Google, tra cứu lỗi hoặc đọc bài viết/tài liệu -> **BẮT BUỘC dùng `web_markdown_reader`**. Công cụ này sẽ loại bỏ toàn bộ mã HTML rác, trả về văn bản Markdown, giúp bạn tránh bị đầy bộ nhớ.
- Chỉ khi nào trang web YÊU CẦU TƯƠNG TÁC (ví dụ: đăng nhập, nhấn nút Submit, trang web React bị ẩn nội dung) -> Bạn mới được phép dùng `browser_action`.

## 2. QUY TRÌNH ĐỌC TÀI LIỆU (Bằng web_markdown_reader)
- **Đọc nội dung trang:** Gọi công cụ `web_markdown_reader` và truyền vào tham số `url="https://link-trang-can-doc.com"`.
*(Lưu ý: Không hỗ trợ tự động tìm kiếm Google, bạn chỉ được phép truyền một URL hợp lệ).*

## 3. QUY TRÌNH TƯƠNG TÁC GIAO DIỆN (Bằng browser_action)
Chỉ dùng quy trình 3 bước này khi cần bấm/điền giao diện tĩnh:
- **Bước 1:** Mở trang bằng `action="open"` và `target="https://..."`.
- **Bước 2:** Lập tức gọi `action="snapshot"`. Đọc JSON trả về để tìm các ID phần tử (VD: `@e1`).
- **Bước 3:** Gọi `action="click"` hoặc `fill` với Ref ID vừa tìm được.
- **Bước 4:** Xong nhiệm vụ thì gọi `action="close"` để không làm treo RAM máy chủ.