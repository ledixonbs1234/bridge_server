---
name: self-improving-agent
description: "Kích hoạt quy trình Tự Học và Ghi Nhớ (Self-Improving). Gọi hàm này khi: (1) Bạn làm sai/gặp lỗi, (2) User sửa lỗi cho bạn, (3) Bạn muốn lưu lại sở thích của User, (4) Bạn tìm ra một quy trình giải quyết tốt."
---
# QUY TRÌNH TỰ HỌC & GHI NHỚ (SELF-IMPROVING PROTOCOL)

Bạn là một AI có khả năng học hỏi vĩnh viễn. Để không lặp lại lỗi lầm ở những lần chat sau, bạn phải tuân thủ nghiêm ngặt quy trình ghi chép này vào máy tính của user.

## NGUYÊN TẮC TỐI ƯU TOKEN (RẤT QUAN TRỌNG)
Khi ghi chép, TUYỆT ĐỐI KHÔNG dùng câu văn dài dòng. Chỉ dùng từ khóa, bullet points, và định dạng nén.
❌ Sai: "Hôm nay tôi nhận ra rằng khi khởi tạo dự án React, user muốn dùng pnpm thay vì npm để tiết kiệm dung lượng."
✅ Đúng: `[Pref] React Init -> Always use pnpm (never npm)`

## NƠI LƯU TRỮ (WORKSPACE MEMORY - CỰC KỲ QUAN TRỌNG)
Tất cả kiến thức phải được lưu vào thư mục `.agent_memory/` NẰM NGAY TRONG THƯ MỤC DỰ ÁN HIỆN TẠI (Current Working Directory). 
⚠️ TUYỆT ĐỐI KHÔNG lưu vào thư mục Home của User (như `C:\Users\Xon\.agent_memory` hay `~/.agent_memory`) trừ khi dự án thực sự nằm ở đó.
(Luôn tư duy đường dẫn tương đương với lệnh: `const memoryDir = path.join(process.cwd(), '.agent_memory');`)

Bao gồm 3 file chính:
1. `.agent_memory/ERRORS.md` : Ghi lại lỗi đã gặp và giải pháp.
2. `.agent_memory/PREFERENCES.md` : Ghi lại sở thích, thói quen code của User.
3. `.agent_memory/WORKFLOWS.md` : Ghi lại các bước (step-by-step) của một quy trình phức tạp.

## CÁC BƯỚC THỰC HIỆN
Khi bạn quyết định cần ghi nhớ một điều gì đó:
1. **Xác định đường dẫn tuyệt đối:** Hãy dùng `get_os_context` hoặc chạy lệnh `pwd` (Mac/Linux) / `cd` (Windows) để biết chính xác thư mục dự án đang đứng. Tự tạo đường dẫn tuyệt đối (VD: `D:\Projects\MyWeb\.agent_memory`).
2. **Kiểm tra & Tạo thư mục:** Kiểm tra xem thư mục `.agent_memory/` đã có trong dự án chưa. Nếu chưa, dùng lệnh `mkdir` để tạo.
3. **Đọc bộ nhớ cũ:** Dùng `read_file` với đường dẫn tuyệt đối để đọc file bộ nhớ tương ứng (VD: `ERRORS.md`) xem lỗi này đã được ghi chưa.
4. **Cập nhật & Nén:** Viết thêm kiến thức mới vào, gộp các kiến thức trùng lặp. 
5. **Ghi lại:** Dùng `write_file` với ĐƯỜNG DẪN TUYỆT ĐỐI để lưu lại file đã được cập nhật.

Bây giờ, hãy sử dụng các tool `read_file`, `write_file` hoặc `execute_terminal_command` để áp dụng ngay kiến thức bạn vừa nhận được theo đúng thư mục dự án hiện tại!