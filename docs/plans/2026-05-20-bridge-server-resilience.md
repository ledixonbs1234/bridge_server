# Bridge Server Resilience Upgrade Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the workflow pipeline system to prevent agent drift, context decay, and infinite loops using a split-role execution/validation architecture, git-status aware rollbacks, context-compacting journals, and interactive Human-in-the-Loop circuit breakers.

**Architecture:** Split each step in `WorkflowEngine` into separate Executor (Worker) and Validator phases. The Validator runs deterministic checks or initiates a separate validator session. If a step fails, git changes made during that step are rolled back before retrying. If retries run out, an interactive CLI menu is presented to the user.

**Tech Stack:** Node.js ES Modules, SQLite, `child_process` (execSync), chalk, Inquirer.

---

### Task 1: Update Pipeline Plan Skill to Support Validation Specs

**Files:**
- Modify: [pipeline.js](file:///h:/DATA/NODEJS/bridge_server/skills/pipeline.js)

**Step 1: Write the failing test / mock validation**
Since there isn't a test suite for skills directly, we will construct a mock runner/verification pattern using a local scratch script.
Create test script `scratch/test_pipeline_validation.js` to call the modified skill handler with a mock pipeline containing validation options, checking that the output database JSON payload includes the `validation` fields.

**Step 2: Run verification script**
Run: `node scratch/test_pipeline_validation.js`
Expected: Failure/Error because `validation` parameter is not yet defined in the JSON schema or schema validator rejects it.

**Step 3: Modify pipeline.js schema and handler**
Modify `pipeline.js` to allow a `validation` object for each step:
```javascript
validation: {
    type: "object",
    description: "Phương thức kiểm tra kết quả bước này",
    properties: {
        type: { type: "string", enum: ["command", "file_exists", "llm_check"], description: "Loại validation: chạy lệnh terminal, kiểm tra file tồn tại, hoặc dùng LLM tự kiểm tra." },
        value: { type: "string", description: "Lệnh chạy, đường dẫn file, hoặc prompt mô tả tiêu chí kiểm tra cho LLM." }
    },
    required: ["type", "value"]
}
```

**Step 4: Verify schema validation works**
Run: `node scratch/test_pipeline_validation.js`
Expected: Success. The pipeline is validated and correctly stored in the SQLite database with validation criteria.

**Step 5: Commit**
```bash
git add skills/pipeline.js
git commit -m "feat: add validation schema support to pipeline plan"
```

---

### Task 2: Implement Git Status Tracking & Rollback Helper in WorkflowEngine

**Files:**
- Modify: [workflow_engine.js](file:///h:/DATA/NODEJS/bridge_server/workflow_engine.js)

**Step 1: Write scratch test for git status and rollback helper**
Create `scratch/test_git_rollback.js` that:
1. Instantiates a mock WorkflowEngine.
2. Performs `getGitStatus()`.
3. Creates a temp file and modifies an existing file.
4. Performs `rollbackChanges(preStatus)` and verifies the temp file is deleted and the modified file is reverted.

**Step 2: Run verification script**
Run: `node scratch/test_git_rollback.js`
Expected: Fail (methods do not exist).

**Step 3: Add git tracking and rollback helpers to workflow_engine.js**
Add `getGitStatus()` and `rollbackChanges(preStepStatus)` using `execSync` and `fs` operations to only revert changes made during the current step.

**Step 4: Run verification script**
Run: `node scratch/test_git_rollback.js`
Expected: Pass. Modified files are reverted, and untracked files created during the step are deleted.

**Step 5: Commit**
```bash
git add workflow_engine.js
git commit -m "feat: add git status and selective rollback helper to workflow engine"
```

---

### Task 3: Implement Validator Phase & Summary Generator in WorkflowEngine

**Files:**
- Modify: [workflow_engine.js](file:///h:/DATA/NODEJS/bridge_server/workflow_engine.js)

**Step 1: Write scratch test for validation and summary generation**
Create `scratch/test_validation_engine.js` that sets up a mock pipeline step with a command validator (`node -e "process.exit(0)"`), checks validation success, and triggers LLM-based verification/summary mocks.

**Step 2: Run verification script**
Run: `node scratch/test_validation_engine.js`
Expected: Fail.

**Step 3: Implement `validateStep` and `generateStepSummary` methods in `workflow_engine.js`**
Add:
- Support for `file_exists` checks.
- Support for `command` execution checks.
- Support for `llm_check` agent checks via separate provider sessions.
- Support for generating a single-sentence `summary` for the Journal.

**Step 4: Run verification script**
Run: `node scratch/test_validation_engine.js`
Expected: Pass.

**Step 5: Commit**
```bash
git add workflow_engine.js
git commit -m "feat: implement validation and summary generation in workflow engine"
```

---

### Task 4: Upgrade Main Step Execution Loop with Journal, Compaction & HITL Circuit Breaker

**Files:**
- Modify: [workflow_engine.js](file:///h:/DATA/NODEJS/bridge_server/workflow_engine.js)

**Step 1: Write comprehensive workflow engine integration test**
Create `scratch/test_workflow_loop.js` that runs a full pipeline with mixed passing/failing steps and verifies retries, journals, rollbacks, and interactive choice menus.

**Step 2: Run integration test**
Run: `node scratch/test_workflow_loop.js`
Expected: Fail.

**Step 3: Update `run()` method in `workflow_engine.js`**
Refactor the loop to:
1. Carry forward the journal of completed step summaries.
2. Track `retryCount` (max 3).
3. Record git status pre-step.
4. Run the constrained worker agent.
5. Invoke the validator.
6. Trigger rollbacks on validation or execution failure.
7. Trigger `handleHITL` prompt when retry limits are reached.

**Step 4: Run integration test**
Run: `node scratch/test_workflow_loop.js`
Expected: Pass. All resilient flows run successfully.

**Step 5: Commit**
```bash
git add workflow_engine.js
git commit -m "feat: integrate validation loop, context compaction, and hitl circuit breaker"
```

---

## Verification Plan

### Automated Tests
- Run scratch suite scripts:
  - `node scratch/test_pipeline_validation.js`
  - `node scratch/test_git_rollback.js`
  - `node scratch/test_validation_engine.js`
  - `node scratch/test_workflow_loop.js`

### Manual Verification
- Launch the Bridge Server and trigger a complex multi-stage pipeline using `__HANDOVER_TO_ENGINE__`.
- Intentionally fail a step (e.g. invalid command or syntax error) and verify that:
  - The engine tries 3 times.
  - The engine rolls back changes made during the failed attempts.
  - The engine prompts the user with choices (`r`/`s`/`h`/`q`).
  - Choosing `h` allows editing the file, pressing Enter re-validates, and proceeds correctly on success.
