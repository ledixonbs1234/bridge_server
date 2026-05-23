---
name: architecture-design
description: Thiết kế kiến trúc hệ thống, xác định components, integration points, và đánh giá technical risks.
---

# Skill: Architecture Design

## Mục đích

Thiết kế kiến trúc kỹ thuật cho giải pháp, bao gồm:
- **Component design:** Các thành phần chính và trách nhiệm
- **Data flow:** Luồng dữ liệu giữa các components
- **Integration points:** APIs, services, external dependencies
- **Technical decisions:** Trade-offs và justifications
- **Risk assessment:** Rủi ro kỹ thuật và mitigations

## Nguyên tắc thiết kế

### 1. Separation of Concerns
Mỗi component có một trách nhiệm rõ ràng, không overlap với components khác.

### 2. Single Source of Truth
Mỗi data entity có một nơi quản lý duy nhất, tránh inconsistency.

### 3. Fail-Fast Design
Phát hiện lỗi sớm, ở layer thấp nhất có thể.

### 4. Defense in Depth
Nhiều lớp bảo vệ thay vì relying vào single point of security.

### 5. Scalability Considerations
Thiết kế để có thể scale horizontal/vertical khi cần.

### 6. Observability by Default
Logging, metrics, tracing được built-in từ đầu.

## Quy trình 6 bước

### Bước 1: Identify Components
Liệt kê các thành phần chính:
- **User-facing:** UI, API endpoints, CLI
- **Business logic:** Services, domain models
- **Data layer:** Databases, caches, message queues
- **Infrastructure:** Load balancers, CDN, monitoring

### Bước 2: Define Interfaces
Với mỗi component, xác định:
- **Public API:** Methods/endpoints exposed
- **Input contracts:** Schema, validation rules
- **Output contracts:** Response format, error codes
- **Dependencies:** Other components it relies on

### Bước 3: Design Data Flow
Vẽ luồng dữ liệu cho các use cases chính:
```
User Request → API Gateway → Auth Service → Business Logic → Database
                                                              ↓
Response ← Serializer ← Controller ← Service ← Repository ← Cache
```

### Bước 4: Make Technical Decisions
Document các quyết định quan trọng:
- **Database choice:** SQL vs NoSQL, specific technology
- **Communication pattern:** REST vs GraphQL vs gRPC
- **Caching strategy:** Where, what, how long
- **Security approach:** AuthN/AuthZ, encryption, rate limiting

### Bước 5: Assess Risks
Identify technical risks:
- **Single points of failure**
- **Performance bottlenecks**
- **Security vulnerabilities**
- **Operational complexity**

### Bước 6: Create Migration Plan (nếu applicable)
Nếu đây là thay đổi trên hệ thống existing:
- **Phase 1:** Preparation (feature flags, monitoring)
- **Phase 2:** Parallel run (old + new coexist)
- **Phase 3:** Cutover (switch traffic)
- **Phase 4:** Cleanup (remove old code)

## Output Template

```markdown
## 🏗️ Architecture Design Document

### 1. Overview
[High-level description của hệ thống/giải pháp]

### 2. System Context Diagram
```
┌─────────────┐      ┌──────────────┐      ┌─────────────┐
│   External  │─────▶│   Your       │◀─────│   External  │
│   System A  │      │   System     │      │   Service B │
└─────────────┘      └──────────────┘      └─────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │   Database   │
                     └──────────────┘
```

### 3. Component Architecture
#### Core Components
| Component | Responsibility | Technology | Owner |
|-----------|---------------|------------|-------|
| [Name] | [What it does] | [Tech stack] | [Team/person] |

#### Component Details
**[Component Name]**
- **Purpose:** [Why it exists]
- **Interfaces:** [APIs exposed]
- **Dependencies:** [What it depends on]
- **Data stored:** [If any]

### 4. Data Flow
#### Use Case: [Primary use case name]
```
Step 1: User → [Component A]: [Action]
Step 2: [Component A] → [Component B]: [Request]
Step 3: [Component B] → [Database]: [Query]
Step 4: [Database] → [Component B]: [Result]
Step 5: [Component B] → [Component A]: [Response]
Step 6: [Component A] → User: [Final output]
```

#### Data Models
```typescript
// Example schema
interface User {
  id: string;
  email: string;
  // ...
}
```

### 5. Integration Points
#### External APIs
| API | Purpose | Auth Method | Rate Limit | SLA |
|-----|---------|-------------|------------|-----|
| [Service] | [Why used] | [OAuth/API Key] | [X req/min] | [99.9%] |

#### Internal Services
| Service | Contract | Version | Deprecation Plan |
|---------|----------|---------|------------------|
| [Service] | [API spec link] | [v1/v2] | [If applicable] |

### 6. Technical Decisions
| Decision | Options Considered | Chosen | Rationale |
|----------|-------------------|--------|-----------|
| [Decision] | [Option A, Option B] | [Chosen] | [Why this option] |

### 7. Cross-Cutting Concerns
#### Security
- [Authentication approach]
- [Authorization model]
- [Data encryption (at rest/in transit)]
- [Input validation strategy]

#### Performance
- [Caching layers]
- [Database indexing strategy]
- [Async processing opportunities]
- [CDN usage]

#### Observability
- [Logging framework and levels]
- [Metrics to track]
- [Tracing implementation]
- [Alerting thresholds]

#### Reliability
- [Retry policies]
- [Circuit breaker patterns]
- [Fallback mechanisms]
- [Disaster recovery plan]

### 8. Risk Assessment
| Risk | Category | Likelihood | Impact | Mitigation |
|------|----------|------------|--------|------------|
| [Risk description] | [Security/Performance/Ops] | High/Med/Low | High/Med/Low | [How to mitigate] |

### 9. Deployment Architecture
```
┌─────────────────────────────────────────────────────────┐
│                    Production Environment                │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐ │
│  │   Web Tier  │    │  App Tier   │    │  Data Tier  │ │
│  │  (Load Bal) │───▶│  (Services) │───▶│  (Database) │ │
│  └─────────────┘    └─────────────┘    └─────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 10. Open Questions
- [Question 1 cần research thêm]
- [Question 2 cần stakeholder input]

### 11. Next Steps
1. [ ] [Action item 1 with owner]
2. [ ] [Action item 2 with owner]
3. [ ] [Review meeting scheduled]
```

## Khi nào invoke skill này

### ✅ Nên dùng khi:
- Bắt đầu project/product mới
- Thêm tính năng lớn có architectural impact
- Refactoring/restructuring hệ thống
- Giải quyết technical debt significant
- Scaling preparation

### ❌ Không cần dùng khi:
- Bug fix đơn giản
- Small feature không ảnh hưởng architecture
- Routine maintenance tasks

## Integration Points

Skill này thường được gọi ở **Phase 2** của Orchestrator workflow:

```
requirement-analysis → architecture-design → implementation-planning
```

## Quality Gates

Trước khi hoàn thành skill này, đảm bảo:
- [ ] Tất cả components đã được identify với clear responsibilities
- [ ] Data flows documented cho critical use cases
- [ ] Technical decisions có rationale rõ ràng
- [ ] Top 5 risks đã được identified với mitigations
- [ ] Security considerations addressed
- [ ] Observability plan defined

## Anti-patterns to Avoid

❌ **Over-engineering** - Đừng design cho scale chưa cần thiết
❌ **Big Design Up Front** - Iterative design tốt hơn perfect initial design
❌ **Ignoring operational concerns** - DevOps/monitoring phải được consider từ đầu
❌ **No fallback plans** - Luôn có plan B cho critical components
❌ **Documentation drift** - Update docs khi code changes

## References

- [12 Factor App](https://12factor.net/)
- [Domain-Driven Design](https://domainlanguage.com/ddd/)
- [Microservices Patterns](https://microservices.io/patterns/)
- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)
