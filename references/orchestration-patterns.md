# Orchestration Patterns Catalog

Reference catalog of agent orchestration patterns for intelligent AI workflow. Read this before adding new slash commands or personas.

---

## Endorsed Patterns

### Pattern 1: 5-Phase Intelligent Orchestration

Master pattern for complex tasks requiring analysis, design, and multi-step execution.

```
┌─────────────────────────────────────────────────────────────┐
│                    USER REQUEST                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  PHASE 1: REQUIREMENT ANALYSIS                              │
│  Skill: requirement-analysis                                │
│  Output: Requirement Analysis Report                        │
│  Quality Gate: Use cases, scope, success criteria, risks   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  PHASE 2: ARCHITECTURE DESIGN                               │
│  Skill: architecture-design                                 │
│  Output: Architecture Design Document                       │
│  Quality Gate: Components, data flows, decisions, security │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  PHASE 3: IMPLEMENTATION PLANNING                           │
│  Skill: implementation-planning                             │
│  Output: Implementation Plan + Pipeline JSON                │
│  Quality Gate: Atomic tasks, dependencies, validations     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  PHASE 4: ORCHESTRATED EXECUTION                            │
│  - Sequential: /spec → /plan → /build → /test              │
│  - Parallel: /ship (review + security + test)              │
│  - Circuit breaker: Stop after 5 retries or error loop     │
│  - Rollback: Execute plan B if needed                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  PHASE 5: SYNTHESIS & DELIVERY                              │
│  - Consolidate all agent reports                            │
│  - Generate final summary with evidence                     │
│  - GO/NO-GO decision                                        │
│  - Memorize lessons & rules                                 │
└─────────────────────────────────────────────────────────────┘
```

**Use when:**
- Complex task requiring >3 steps
- Multiple dependencies between tasks
- Need coordination of specialist agents
- High risk requiring checkpoints

**Examples:**
- New feature development
- System migration
- Performance optimization project

---

### Pattern 2: Reasoning Chain (Chain of Thought)

Force explicit reasoning before important decisions.

```
┌─────────────────────────────────────────────────────────────┐
│  DECISION POINT                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  1. SITUATION ANALYSIS                                      │
│  - Context: [description]                                   │
│  - Constraints: [list]                                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  2. OPTIONS                                                 │
│  - Option A: Pros [...], Cons [...]                         │
│  - Option B: Pros [...], Cons [...]                         │
│  - Option C: Pros [...], Cons [...]                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  3. EVALUATION CRITERIA                                     │
│  - Criterion 1 (weight: X%)                                 │
│  - Criterion 2 (weight: Y%)                                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  4. OPTIMAL CHOICE + JUSTIFICATION                          │
│  - Selected: Option X                                       │
│  - Why: [clear rationale]                                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  5. FALLBACK PLAN                                           │
│  - If X fails → Do Y                                        │
│  - Trigger conditions: [...]                                │
└─────────────────────────────────────────────────────────────┘
```

**Use when:**
- Technical architecture decisions
- Technology selection
- Trade-off analysis
- Risk mitigation planning

---

### Pattern 3: Quality Gates

Mandatory checkpoints before phase transitions.

```
Phase N completed?
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  QUALITY GATE CHECKLIST                                     │
│  □ Criterion 1                                              │
│  □ Criterion 2                                              │
│  □ Criterion 3                                              │
│  □ Criterion 4                                              │
└─────────────────────────────────────────────────────────────┘
        │
        ├── ALL PASS → Proceed to Phase N+1
        │
        └── ANY FAIL → Return to Phase N, fix issues, re-check
```

**Gates defined:**
- **Gate 1:** After Requirement Analysis
- **Gate 2:** After Architecture Design
- **Gate 3:** After Implementation Planning
- **Gate 4:** Before Final Delivery

**Rule:** NEVER bypass a gate! If criteria not met, return to previous phase.

---

### Pattern 4: Parallel Fan-out with Merge

Multiple independent agents work in parallel, results merged by orchestrator.

```
                    ┌─→ code-reviewer    ─┐
/ship → fan out  ───┼─→ security-auditor ─┤→ merge → go/no-go
                    └─→ test-engineer    ─┘
```

**Validation checklist:**
- [ ] Can all sub-agents run simultaneously without ordering issues?
- [ ] Does each persona produce different kinds of findings?
- [ ] Will the merge step fit in main agent's context?
- [ ] Is wall-clock time long enough that parallelism is noticeable?

**Use when:** Independent investigations on same artifact

---

### Pattern 5: Sequential Pipeline (User as Orchestrator)

User runs slash commands in order, carrying context between them.

```
user runs:  /spec  →  /plan  →  /build  →  /test  →  /review  →  /ship
```

**Why user as orchestrator:**
- Human judgment between steps adds value
- No paraphrasing loss between phases
- User controls pace and can investigate tangents

**Use when:** Workflow has dependencies and human checkpoints add value

---

### Pattern 6: Research Isolation

Spawn research sub-agent that returns only a digest, keeping main context clean.

```
main agent → research sub-agent (reads 50 files) → digest → main agent continues
```

**On Claude Code:** Use built-in `Explore` subagent for read-only research.

**Use when:**
- Task requires reading large amounts of material
- Main session needs to stay focused
- Investigation result << input size

---

### Pattern 7: Competing Hypotheses (Agent Teams)

Multiple teammates debate to find root cause among competing theories.

```
Lead Agent spawns:
  - code-reviewer: investigates race conditions
  - security-auditor: investigates auth bottlenecks
  - test-engineer: investigates flaky tests

Teammates message each other directly → challenge theories → consensus
```

**Requires:** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`

**Use when:**
- Debugging complex intermittent issues
- Multiple plausible root causes
- Need adversarial investigation, not just independent reports

---

## Anti-Patterns to Avoid

### ❌ Anti-Pattern A: Persona calls Persona

```
code-reviewer → wants security check → calls security-auditor → paraphrases result → user
```

**Why bad:**
- Adds paraphrasing hops → information loss + 2x token cost
- Violates "personas do not invoke other personas" rule
- Claude Code enforces: "Subagents cannot spawn other subagents"

**Fix:** Let user or slash command orchestrate, not personas.

---

### ❌ Anti-Pattern B: Meta-Orchestrator with no domain value

```
/work-on-pr → meta-orchestrator → decides "needs review" → code-reviewer → meta-orchestrator → user
```

**Why bad:**
- Pure routing layer with no domain expertise
- Replicates work that slash commands already do
- User already knows they want a review

**Fix:** Let user call `/review` directly.

---

### ❌ Anti-Pattern C: Skipping Quality Gates

```
Requirement Analysis → (skip gate check) → Architecture → (skip) → Implementation → FAILURE
```

**Why bad:**
- Garbage in, garbage out
- Errors compound across phases
- No early detection of wrong direction

**Fix:** Enforce quality gates at every phase transition.

---

### ❌ Anti-Pattern D: No Rollback Plan

```
Deploy changes → Critical bug found → Panic → Manual revert → Data loss
```

**Why bad:**
- No predefined exit strategy
- Manual rollback prone to errors
- Extended downtime

**Fix:** Every phase must have documented rollback plan BEFORE execution.

---

### ❌ Anti-Pattern E: Over-Engineering Simple Tasks

```
Simple bug fix → 5-phase orchestration → 2 hours planning → 5 minutes fixing
```

**Why bad:**
- Wastes time and tokens
- Delays delivery
- Frustrates users

**Fix:** Use direct invocation for simple tasks. Reserve orchestration for complex work.

---

## Decision Matrix

```
Is the work a single perspective on a single artifact?
├── Yes → Direct persona invocation (Pattern: Direct)
└── No  → Is it complex (>3 steps, multiple dependencies)?
         ├── Yes → 5-Phase Intelligent Orchestration (Pattern 1)
         └── No  → Are sub-tasks independent?
                  ├── Yes → Parallel Fan-out (Pattern 4)
                  └── No  → Sequential Pipeline (Pattern 5)
```

---

## Integration with Existing Systems

### With Workflow Engine

- Each phase → Stage in pipeline
- Quality gates → Validator agents or deterministic checks
- Checkpoints → Require user approval before continue
- Circuit breaker → Built into workflow_engine.js

### With Memory System

- After Phase 5: Call `memorize_lesson` for technical learnings
- After Phase 5: Call `memorize_rule` for new user preferences
- State persistence: Sync to `runtime_charter.json` for context recovery

### With Provider Abstraction

- Different models per phase for cost optimization:
  - Phase 1-2: Higher intelligence model (Opus/Sonnet)
  - Phase 3-4: Balanced model (Sonnet/Haiku)
  - Phase 5: Higher intelligence for synthesis (Opus/Sonnet)

---

## Examples

### Example 1: Feature Development (Google Login)

```
PHASE 1: Requirement Analysis
- Use cases: new signup, existing user linking
- Constraints: OAuth 2.0 compliance, session management
- Success criteria: <5s login, 99.9% auth success rate

PHASE 2: Architecture Design
- Components: OAuth client, callback handler, token service
- Data flow: User → Google → Callback → Session
- Security: PKCE, state parameter, secure token storage

PHASE 3: Implementation Planning
- T1: Create Google Cloud project
- T2: Implement OAuth callback
- T3: Handle token exchange
- T4: Update user model
- T5: Write tests

PHASE 4: Execution
- Execute T1 → Validate → T2 → Validate → ... 
- Parallel: T5 (tests) while T2-T4 in progress

PHASE 5: Synthesis
- All tests passing ✓
- Security audit passed ✓
- Decision: GO
- Lesson memorized: OAuth PKCE implementation pattern
```

### Example 2: Bug Investigation (Intermittent Checkout Hang)

```
Use Pattern 7: Competing Hypotheses with Agent Teams

Spawn teammates:
- code-reviewer: Investigate race conditions in payment flow
- security-auditor: Check auth fallback paths
- test-engineer: Analyze flaky test patterns

Teammates debate → Consensus: Missing index on cart_items table

Fix implemented → Verified → Lesson memorized
```

### Example 3: Database Migration (MySQL → PostgreSQL)

```
PHASE 1: Requirements
- Scope: Schema conversion, data migration, app changes
- Out of scope: Feature changes
- Success: Zero data loss, <1hr downtime

PHASE 2: Architecture
- Migration tool: pgloader
- Dual-write strategy during transition
- Rollback: Point-in-time recovery

PHASE 3: Planning
- T1: Schema analysis
- T2: Write migration scripts
- T3: Test on staging
- T4: Backup production
- T5: Execute with rollback ready
- T6: Validate integrity

PHASE 4: Execution
- Staging test successful ✓
- Production backup created ✓
- Migration executed ✓
- Validation passed ✓

PHASE 5: Delivery
- Decision: GO
- Lesson: pgloader configuration for MySQL compatibility
```

---

## References

- [12 Factor App](https://12factor.net/)
- [Domain-Driven Design](https://domainlanguage.com/ddd/)
- [Microservices Patterns](https://microservices.io/patterns/)
- [Claude Code Documentation](https://docs.anthropic.com/claude-code/)
- [ReAct Paper](https://arxiv.org/abs/2210.03629)
- [Chain of Thought](https://arxiv.org/abs/2201.11903)
