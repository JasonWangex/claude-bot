---
name: code-audit
description: >
  Context-aware code audit for full-stack projects.
  Triggers: "code review", "audit", "find bugs", "check code quality",
  "review data flow", "check API contracts", "review PR",
  "审查", "审计", "代码审查", "代码审计", "安全审计", "代码走查",
  "review my code", "check for vulnerabilities", "检查安全漏洞",
  "帮我看看代码有没有问题", "分析代码", "check my project".
  Use this skill whenever the user uploads code files and asks for review,
  analysis, or improvement suggestions — even if they don't explicitly
  say "audit". Also trigger when the user pastes code and asks
  "is this OK?" or "any issues here?".
---

# Code Audit Skill

## Principles

- Audit based on actual project context, not textbook checklists
- Report only high-confidence real issues — never fabricate
- Pattern matching ≠ bug — investigate before reporting
- Goal is risk reduction, not perfect code
- If nothing significant found, say so

---

## Step 1: Scan & Scope

Map project structure, identify tech stack, and determine audit scope.

**Detection commands (use as needed):**

```bash
# Project structure overview
find . -type f -name '*.py' -o -name '*.java' -o -name '*.ts' -o -name '*.go' -o -name '*.rs' | head -50
# Auth modules
grep -rl 'auth\|login\|jwt\|token\|session\|OAuth\|passport\|SecurityConfig\|@Secured\|@PreAuthorize' --include='*.{py,java,ts,js,go,rs}' .
# Multi-tenancy markers
grep -rl 'tenant\|org_id\|workspace_id\|team_id\|company_id' --include='*.{py,java,ts,js,go,rs}' .
# Sensitive data fields
grep -rn 'password\|secret\|api_key\|private_key\|credit_card\|ssn\|token' --include='*.{py,java,ts,js,go,rs,yml,yaml,env,json}' .
# API surface
grep -rn '@GetMapping\|@PostMapping\|@app.route\|@router\.\|app.get\|app.post\|HandleFunc\|#\[get\|#\[post' --include='*.{py,java,ts,js,go,rs}' .
# Deployment configs
find . -name 'Dockerfile' -o -name 'docker-compose*' -o -name '*.yaml' -o -name '*.yml' -o -name '.env*' | head -20
# Dependency files
ls -la package.json pom.xml build.gradle requirements.txt go.mod Cargo.toml Gemfile 2>/dev/null
```

---

## Step 2: Dimensional Audit

### 2.1 Code Quality

Check: duplicate code, high complexity (nesting>3 / method>50 lines), dead code, type safety gaps (any abuse), unhandled async errors, magic values, naming inconsistencies.

### 2.2 Architecture & Design

Check: clear separation of concerns, consistency with existing project architecture, backward compatibility (migration path for API/DB changes), abstraction level appropriateness.

**Mark with `[⚠️ NEEDS HUMAN REVIEW]`:** DB schema changes, API contract breaking changes, new framework introductions, security-related changes.

### 2.3 Performance

Check: N+1 queries (DB/API calls in loops), unbounded O(n²) operations, unpaginated full-table queries, unnecessary large object copies, frontend large lists without virtualization/re-render optimization.

### 2.4 Data Flow

Trace along `DB→Model→Service→API→Frontend State→UI→User Action→API→DB`. Check: schema-model mismatch, serialization boundaries (naming/dates/enums), stale frontend state, cache invalidation, data permission gaps.

### 2.5 Frontend-Backend Interaction

Check: request/response contract match, error response handling, missing/orphan endpoints, duplicate submission protection, auth flow, CORS config.

### 2.6 Logic & Exception Handling

**Core phase — logic bugs should always be taken seriously.**

Check: swallowed exceptions, missing null guards, boundary conditions (empty/zero/max/negative), transaction rollback gaps, frontend-only validation, non-idempotent retries, resource leaks, state machine dead paths, async timing/race conditions.

---

## Step 3: Verification & Filtering

**For every finding, verify BEFORE reporting:**

1. Where does the data come from? — User input (flag) vs server config (usually safe)
2. Already handled elsewhere? — Global exception handler, AOP aspects, middleware, interceptors
3. Test coverage exists?
4. Normal framework behavior?

**Common false positives — skip directly:**

**Java/Spring:**
- `@Value("${...}")` is NOT a hardcoded secret
- Spring-managed JdbcTemplate/connection pools are NOT resource leaks
- JPA Criteria / QueryDSL are parameterized queries
- `@GetMapping` without auth annotation → check SecurityConfig global intercept first
- Methods covered by `@Transactional` do not need manual rollback

**JavaScript/TypeScript (Node/React/Vue):**
- axios without catch → check `interceptors.response` first
- Vue `{{ }}` / React `{}` escape by default → only `v-html` / `dangerouslySetInnerHTML` is XSS
- Express `app.use(helmet())` global middleware handles security headers
- Next.js API Routes have no CORS by default → same-origin only, not a vulnerability
- `process.env.XXX` reads env vars, not hardcoded

**Python (Django/Flask/FastAPI):**
- Django ORM `.filter()` / `.exclude()` are parameterized, not SQL injection
- `SECRET_KEY = os.environ.get(...)` in settings.py is NOT hardcoded
- Flask `@login_required` decorator → auth already present
- FastAPI `Depends()` injected dependencies handle auth
- SQLAlchemy `session.query().filter()` is parameterized

**Go:**
- `database/sql` `db.Query(sql, args...)` placeholders are parameterized
- `defer file.Close()` handles resource cleanup
- `http.ListenAndServeTLS` has TLS enabled
- `html/template` escapes HTML by default

**Rust:**
- `sqlx::query!` macro checks at compile time, not SQL injection
- Rust ownership system prevents most resource leaks
- `actix-web` / `axum` extractors auto-return 400 on failure
- `serde` deserialization rejects invalid input automatically

**Confidence threshold:**
- High (clearly triggerable, protections ruled out) → Report
- Medium (suspicious but cannot fully confirm) → Report, mark "needs human review"
- Low (pattern matching only) → **Do NOT report**

---

## Output Format

**Each finding:**
```
[🟠HIGH] Logic | OrderService.java:87
Confidence: high
Issue: Inventory not rolled back after order cancellation
Evidence: cancelOrder() calls updateStatus() but not inventoryService.restore()
Suggestion: Add inventory rollback call in cancelOrder()
```

**Top 5 Priority Fixes** (sorted by actual risk, with code suggestions)

---

## Feedback Principles

- When uncertain, ask: "Have you considered...?"
- Do NOT flag style preferences as issues
- When only minor issues remain, suggest approval
