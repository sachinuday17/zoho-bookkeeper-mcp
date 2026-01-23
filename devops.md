# DevOps Pipeline Setup

## Components

1. **AI Code Review** - Qodo (or similar: CodeRabbit, Sourcery)
2. **CI Pipeline** - Build → Test → Coverage analysis
3. **Test Framework** - Vitest with coverage thresholds

## Setup

### 1. AI Code Review

Install Qodo (or equivalent) as a Git platform app, then add config:

```toml
# .pr_agent.toml
[pr_reviewer]
extra_instructions = """
Focus on: security vulnerabilities, logic bugs, error handling gaps
Ignore: style issues (handled by linters)
"""

[github_action_config]
auto_review = true
auto_describe = true
```

### 2. CI Pipeline

Create a workflow with three stages:

```yaml
# Stage 1: Build & Lint
build:
  - install dependencies
  - run formatter check
  - run linter
  - compile/build

# Stage 2: Test with Coverage
test:
  - run tests
  - generate coverage report (json-summary format)
  - upload coverage artifact

# Stage 3: Coverage Analysis
coverage:
  - download coverage artifact
  - check threshold and warn if below target
```

### 3. Test Coverage

Configure test runner to output `json-summary`:

```typescript
// vitest.config.ts (or jest.config.js equivalent)
coverage: {
  reporter: ['text', 'json-summary', 'html'],
  thresholds: { lines: 60, functions: 60, branches: 50 }
}
```

## Test Generation

Ask Claude Code when needed:
> "Generate tests for files with coverage below 60%"

No API keys or automated workflows required.
