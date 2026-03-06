# Body Template

```markdown
## Objective & Completion Criteria
<description>

## Current Status
**Progress**: 0/N | **Next**: <g2t1> | **Blocked by**: none

## Subtasks

> ID format: `g<seq>t<N>`, where seq is the Goal's auto-increment number (`seq` field from API). Example: seq=2 -> `g2t1`, `g2t2`.
> Phase annotation `p:N` controls execution order -- all tasks in phase N complete before phase N+1 starts. Tasks in the same phase run in parallel.

- [ ] `[代码, simple, p:1]` g2t1: description -- technical notes
- [ ] `[调研, p:1]` g2t2: description
- [ ] `[代码, complex, p:2]` g2t3: description -- technical notes
- [ ] `[代码, simple, p:2]` g2t4: description
- [ ] `[手动, p:3]` g2t5: description

### g2t1: description `[代码, simple]`
**目标**: ...
**为什么**: ...
**实现**: ...

### g2t2: description `[调研]`
**目标**: ...
**为什么**: ...
**实现**: ...

### g2t3: description `[代码, complex]`
**目标**: ...
**为什么**: ...
**实现**: ...
**注意事项**: ...

## Decision Log
None yet

## Completed Subtask Archive
None yet
```
