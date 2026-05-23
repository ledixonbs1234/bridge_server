---
name: requirement-analysis
description: Phân tích yêu cầu, xác định phạm vi, ràng buộc và tiêu chí thành công trước khi bắt đầu bất kỳ task phức tạp nào.
---

# Skill: Requirement Analysis

## Mục đích

Phân tích sâu yêu cầu của user để hiểu rõ:
- **Intent thực sự** (không chỉ là surface request)
- **Phạm vi** (scope in/out)
- **Ràng buộc** (constraints: technical, business, time)
- **Tiêu chí thành công** (measurable outcomes)
- **Rủi ro tiềm ẩn** (risks và mitigations)

## Quy trình 5 bước

### Bước 1: Parse User Intent
Đặt câu hỏi làm rõ (nếu cần):
- "Bạn muốn đạt điều gì cuối cùng?"
- "Ai sẽ sử dụng tính năng này?"
- "Có integration nào với hệ thống hiện tại không?"

Nếu yêu cầu đã rõ, proceed sang bước 2.

### Bước 2: Identify Stakeholders & Use Cases
Liệt kê:
- **Primary users:** Ai sẽ tương tác trực tiếp?
- **Secondary users:** Ai bị ảnh hưởng gián tiếp?
- **Use cases chính:** Các kịch bản sử dụng quan trọng
- **Edge cases:** Trường hợp biên cần xử lý

### Bước 3: Define Scope
Phân chia rõ ràng:

**In Scope (Sẽ làm):**
- [List các tính năng/tasks sẽ thực hiện]

**Out of Scope (Không làm lần này):**
- [List các tính năng/tasks để sau]

**Assumptions (Giả định):**
- [List các giả định đang được chấp nhận]

### Bước 4: Identify Constraints
Phân loại ràng buộc:

| Loại | Mô tả | Impact |
|------|-------|--------|
| **Technical** | Stack hiện tại, dependencies, infrastructure | Ảnh hưởng architecture |
| **Business** | Deadline, budget, compliance requirements | Ảnh hưởng priority |
| **Resource** | Team size, skill availability, tooling | Ảnh hưởng timeline |

### Bước 5: Define Success Criteria
Tiêu chí phải **SMART**:
- **S**pecific: Cụ thể, rõ ràng
- **M**easurable: Đo lường được
- **A**chievable: Khả thi
- **R**elevant: Liên quan đến mục tiêu
- **T**ime-bound: Có thời hạn

Example:
```
✅ Good: "API response time < 200ms cho 95% requests dưới tải 1000 req/s"
❌ Bad: "API phải nhanh"
```

## Output Template

```markdown
## 📋 Requirement Analysis Report

### 1. Executive Summary
[1-2 paragraph tóm tắt yêu cầu và mục tiêu]

### 2. Stakeholders & Use Cases
#### Primary Users
- [User type 1]: [Needs/Goals]
- [User type 2]: [Needs/Goals]

#### Key Use Cases
| ID | Use Case | Priority | Notes |
|----|----------|----------|-------|
| UC1 | ... | High/Medium/Low | ... |

#### Edge Cases Identified
- [Edge case 1 với impact assessment]
- [Edge case 2]

### 3. Scope Definition
#### In Scope
- ✅ [Item 1]
- ✅ [Item 2]

#### Out of Scope
- ⏸️ [Item 1 - để phase sau]
- ⏸️ [Item 2 - không thuộc project]

#### Assumptions
- ℹ️ [Assumption 1]
- ℹ️ [Assumption 2]

### 4. Constraints
#### Technical Constraints
- [Constraint 1]: [Impact description]
- [Constraint 2]: [Impact description]

#### Business Constraints
- [Constraint 1]: [Deadline/budget/compliance]

#### Resource Constraints
- [Team/tooling limitations]

### 5. Success Criteria
| Criteria | Measurement | Target | Verification Method |
|----------|-------------|--------|---------------------|
| [Criterion 1] | [Metric] | [Target value] | [How to verify] |
| [Criterion 2] | [Metric] | [Target value] | [How to verify] |

### 6. Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| [Risk 1] | High/Medium/Low | High/Medium/Low | [Mitigation strategy] |
| [Risk 2] | High/Medium/Low | High/Medium/Low | [Mitigation strategy] |

### 7. Recommendations for Next Phase
- [Recommendation 1: kiến trúc/công nghệ/approach]
- [Recommendation 2: quy trình/testing strategy]
```

## Khi nào invoke skill này

### ✅ Nên dùng khi:
- Yêu cầu mơ hồ hoặc quá lớn
- Chưa rõ scope và success criteria
- Có nhiều stakeholders với conflicting needs
- Task có rủi ro cao hoặc complexity lớn

### ❌ Không cần dùng khi:
- Yêu cầu đơn giản, rõ ràng (ví dụ: "Sửa bug ở line 42")
- User đã cung cấp đầy đủ spec chi tiết
- Task là routine/maintenance work

## Integration Points

Skill này thường được gọi ở **Phase 1** của Orchestrator workflow:

```
Orchestrator → requirement-analysis → architecture-design → implementation-planning
```

## Examples

### Example 1: Feature Request
**Input:** "Tôi muốn thêm tính năng đăng nhập bằng Google"

**Output highlights:**
- Use cases: new user signup, existing user linking
- Edge cases: email collision, token expiration
- Constraints: OAuth 2.0 compliance, session management
- Success criteria: < 5s login time, 99.9% auth success rate

### Example 2: Migration Project
**Input:** "Chuyển database từ MySQL sang PostgreSQL"

**Output highlights:**
- Scope: data migration, schema conversion, application changes
- Out of scope: feature changes, UI updates
- Risks: data loss, downtime, query incompatibility
- Success criteria: zero data loss, < 1hr downtime, all tests pass

### Example 3: Performance Optimization
**Input:** "Website load quá chậm, cần tối ưu"

**Output highlights:**
- Stakeholders: end users, SEO team, marketing
- Metrics: LCP, FID, CLS (Core Web Vitals)
- Constraints: no breaking changes, backward compatibility
- Success criteria: LCP < 2.5s, performance score > 90

## Quality Gates

Trước khi hoàn thành skill này, đảm bảo:
- [ ] Tất cả use cases chính đã được identify
- [ ] Scope boundaries rõ ràng (in/out)
- [ ] Ít nhất 3 success criteria measurable
- [ ] Top 3 risks đã được identified với mitigations
- [ ] User/stakeholder đã approve analysis (nếu có thể)

## Anti-patterns to Avoid

❌ **Jumping to solutions** - Đừng đề xuất implementation trước khi hiểu rõ problem
❌ **Assuming too much** - Explicit assumptions, don't implicit
❌ **Vague success criteria** - "Fast", "reliable" không đo lường được
❌ **Ignoring edge cases** - Edge cases thường là nơi bugs xuất hiện
❌ **No risk assessment** - Luôn nghĩ về what could go wrong
