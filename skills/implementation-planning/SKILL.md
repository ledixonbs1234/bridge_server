---
name: implementation-planning
description: Chuyển thiết kế kiến trúc thành kế hoạch thực thi chi tiết với các bước, validation criteria, và checkpoints.
---

# Skill: Implementation Planning

## Mục đích

Chuyển hóa architecture design thành implementation plan có thể thực thi:
- **Task breakdown:** Chia nhỏ thành units có thể quản lý
- **Sequencing:** Xác định dependencies và thứ tự thực hiện
- **Validation criteria:** Định nghĩa "done" cho mỗi task
- **Risk mitigation:** Plans cho các scenarios
- **Timeline estimation:** Rough time boxes (optional)

## Nguyên tắc planning

### 1. Atomic Tasks
Mỗi task nên:
- Có thể hoàn thành trong 1-4 giờ
- Có clear input/output
- Có thể test độc lập
- Có owner xác định

### 2. Dependency Mapping
Explicit dependencies giữa tasks:
- **Hard dependencies:** Task B không thể bắt đầu nếu A chưa xong
- **Soft dependencies:** Task B hiệu quả hơn nếu làm sau A
- **No dependencies:** Có thể làm parallel

### 3. Validation First
Define validation criteria BEFORE implementation:
- Tests cần viết
- Metrics cần track
- Manual verification steps

### 4. Checkpoint Design
Insert checkpoints tại:
- Sau mỗi major milestone
- Trước khi merge vào main branch
- Trước khi deploy to production

### 5. Rollback Planning
Mỗi phase phải có rollback plan:
- How to revert changes
- How to restore data
- How to communicate to stakeholders

## Quy trình 7 bước

### Bước 1: Review Architecture & Requirements
Input từ previous phases:
- Requirement Analysis Report
- Architecture Design Document
- Success Criteria

Ensure alignment trước khi planning.

### Bước 2: Identify Work Streams
Phân chia work thành streams:
- **Backend:** API, database, business logic
- **Frontend:** UI components, state management
- **DevOps:** CI/CD, infrastructure, monitoring
- **QA:** Test planning, automation
- **Documentation:** API docs, user guides

### Bước 3: Break Down Tasks
Với mỗi work stream, break down thành tasks:
```
Epic: Implement Google Login
├─ Story: OAuth Integration
│  ├─ Task: Create Google Cloud project & credentials
│  ├─ Task: Implement OAuth callback endpoint
│  ├─ Task: Handle token exchange
│  └─ Task: Store refresh tokens securely
├─ Story: User Session Management
│  ├─ Task: Update user model for OAuth
│  ├─ Task: Modify login flow
│  └─ Task: Handle account linking
└─ Story: Testing
   ├─ Task: Write unit tests
   ├─ Task: Write integration tests
   └─ Task: Manual QA checklist
```

### Bước 4: Define Validation Criteria
Với mỗi task, define:
- **Automated tests:** Unit, integration, E2E
- **Manual checks:** UI review, edge case testing
- **Performance metrics:** Response time, error rate
- **Security checks:** AuthZ, input validation

### Bước 5: Sequence Tasks
Tạo dependency graph:
```
A → B → C
    ↓
    D → E
```

Identify critical path và parallel opportunities.

### Bước 6: Assign Risk Buffers
Cho high-risk tasks:
- Add time buffer (1.5x - 2x estimate)
- Plan spike/research task trước
- Define fallback approach

### Bước 7: Create Execution Timeline
Optional nhưng helpful:
- Group tasks into sprints/phases
- Identify key milestones
- Schedule review meetings

## Output Template

```markdown
## 📋 Implementation Plan

### 1. Overview
**Project:** [Project name]
**Based on:** [Architecture doc version]
**Planned by:** [Name/Team]
**Date:** [Planning date]

### 2. Work Streams
| Stream | Description | Lead | Estimated Effort |
|--------|-------------|------|------------------|
| Backend | API, DB, services | [Name] | [X story points/days] |
| Frontend | UI, UX, state | [Name] | [X story points/days] |
| DevOps | Infra, CI/CD | [Name] | [X story points/days] |
| QA | Testing | [Name] | [X story points/days] |

### 3. Task Breakdown

#### Phase 1: Foundation
| ID | Task | Stream | Dependencies | Validation | Est. Time | Status |
|----|------|--------|--------------|------------|-----------|--------|
| T1.1 | [Task name] | Backend | None | [Tests/checks] | 2h | ⏳ Pending |
| T1.2 | [Task name] | Frontend | T1.1 | [Tests/checks] | 4h | ⏳ Pending |

#### Phase 2: Core Features
| ID | Task | Stream | Dependencies | Validation | Est. Time | Status |
|----|------|--------|--------------|------------|-----------|--------|
| T2.1 | [Task name] | Backend | T1.2 | [Tests/checks] | 3h | ⏳ Pending |

#### Phase 3: Integration & Testing
| ID | Task | Stream | Dependencies | Validation | Est. Time | Status |
|----|------|--------|--------------|------------|-----------|--------|
| T3.1 | [Task name] | QA | T2.1 | [Tests/checks] | 4h | ⏳ Pending |

### 4. Dependency Graph
```
Phase 1              Phase 2              Phase 3
┌─────────┐         ┌─────────┐         ┌─────────┐
│  T1.1   │────────▶│  T2.1   │────────▶│  T3.1   │
└─────────┘         └─────────┘         └─────────┘
     │                   │
     ▼                   ▼
┌─────────┐         ┌─────────┐
│  T1.2   │────────▶│  T2.2   │
└─────────┘         └─────────┘
```

### 5. Detailed Task Specs

#### Task T1.1: [Task Name]
**Description:** [What needs to be done]

**Acceptance Criteria:**
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

**Technical Notes:**
```typescript
// Code snippets, pseudo-code, or references
interface ExpectedInput { ... }
interface ExpectedOutput { ... }
```

**Validation Steps:**
1. Run unit tests: `npm test -- T1.1`
2. Verify manual checklist: [link]
3. Check performance: response time < X ms

**Risks & Mitigations:**
- Risk: [Description] → Mitigation: [Plan]

---

#### Task T1.2: [Task Name]
...

### 6. Checkpoints & Gates

#### Gate 1: End of Phase 1
**Criteria to pass:**
- [ ] All Phase 1 tasks completed
- [ ] All tests passing
- [ ] Code reviewed and approved
- [ ] Documentation updated

**Review meeting:** [Scheduled time]
**Approvers:** [Names]

#### Gate 2: End of Phase 2
...

### 7. Rollback Plans

#### Rollback for Phase 1
**Trigger conditions:**
- Critical bug found in production
- Performance degradation > X%
- Security vulnerability discovered

**Steps:**
1. Revert commit: `git revert <commit-hash>`
2. Restore database: `pg_restore ...`
3. Redeploy previous version
4. Notify stakeholders

**Estimated rollback time:** 30 minutes

#### Rollback for Phase 2
...

### 8. Open Questions & Decisions Needed
| Question | Impact | Owner | Due Date |
|----------|--------|-------|----------|
| [Question] | [High/Med/Low] | [Name] | [Date] |

### 9. Success Metrics
| Metric | Baseline | Target | Measurement Method |
|--------|----------|--------|-------------------|
| [Metric 1] | [Current value] | [Target value] | [How measured] |
| [Metric 2] | [Current value] | [Target value] | [How measured] |

### 10. Appendix

#### A. Reference Documents
- [Requirement Analysis Doc](link)
- [Architecture Design Doc](link)
- [API Specifications](link)

#### B. Useful Commands
```bash
# Setup
npm install

# Run tests
npm test

# Build
npm run build

# Deploy
npm run deploy
```

#### C. Contact Information
- Tech Lead: [Name, Slack, Email]
- Product Owner: [Name, Slack, Email]
- On-call: [Rotation schedule]
```

## Khi nào invoke skill này

### ✅ Nên dùng khi:
- Đã có architecture design approved
- Sẵn sàng bắt đầu implementation
- Cần tracking progress chi tiết
- Team multiple people cần coordination

### ❌ Không cần dùng khi:
- Task đơn giản (< 1 ngày work)
- Solo project không cần coordination
- Still exploring options (dùng research spike thay vì)

## Integration Points

Skill này thường được gọi ở **Phase 3** của Orchestrator workflow:

```
requirement-analysis → architecture-design → implementation-planning → execution
```

## Quality Gates

Trước khi hoàn thành skill này, đảm bảo:
- [ ] Tất cả tasks atomic và estimable
- [ ] Dependencies explicit và correct
- [ ] Validation criteria measurable
- [ ] Checkpoints defined tại关键 moments
- [ ] Rollback plans documented
- [ ] Stakeholders aligned trên plan

## Anti-patterns to Avoid

❌ **Too granular** - Đừng break down thành tasks < 30 phút
❌ **Missing validation** - Mỗi task phải có clear "done" criteria
❌ **Ignoring dependencies** - Explicit dependencies tránh blockers
❌ **No rollback plan** - Luôn có exit strategy
❌ **Over-committing** - Add buffers cho unknowns
❌ **Plan once, never update** - Update plan khi learn new things

## Tools Integration

### Với Pipeline System
Implementation plan có thể export thành pipeline JSON:
```json
{
  "pipeline_id": "uuid",
  "stages": [
    {
      "name": "Phase 1: Foundation",
      "steps": [
        {
          "step_key": "T1.1",
          "task": "Create Google Cloud project",
          "tool": "execute_terminal_command",
          "validation": { "type": "file_exists", "value": "./credentials.json" }
        }
      ]
    }
  ]
}
```

### Với Workflow Engine
- Mỗi task → một step trong pipeline
- Validation criteria → validator agent hoặc deterministic check
- Checkpoints → gates yêu cầu user approval trước khi continue

## Examples

### Example 1: API Development
**Task breakdown:**
- T1: Design API spec (OpenAPI)
- T2: Implement route handlers
- T3: Add authentication middleware
- T4: Write unit tests
- T5: Integration testing
- T6: Deploy to staging

### Example 2: Database Migration
**Task breakdown:**
- T1: Schema analysis & mapping
- T2: Write migration scripts
- T3: Test migration on staging DB
- T4: Backup production DB
- T5: Execute migration with rollback ready
- T6: Validate data integrity
- T7: Update application connection strings

### Example 3: Feature Flag Rollout
**Task breakdown:**
- T1: Implement feature flag infrastructure
- T2: Wrap new feature in flag
- T3: Internal testing with flag on
- T4: Beta rollout (5% users)
- T5: Monitor metrics, gather feedback
- T6: Gradual rollout (25% → 50% → 100%)
- T7: Remove flag, cleanup code
