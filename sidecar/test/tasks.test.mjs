import assert from "node:assert/strict"
import test from "node:test"

import { buildMockTasks } from "../agent/tasks-mock.mjs"
import { assertValidTasks, TASK_ORIGINS, TASK_STATES, TasksValidationError, validateTasks } from "../agent/tasks.mjs"

const NOW = new Date("2026-11-06T17:12:00Z")
const codes = (result) => result.errors.map((e) => e.code)

test("mock 任务列表合法，且四态齐全", () => {
  const payload = buildMockTasks({ now: NOW })
  assert.deepEqual(validateTasks(payload).errors, [])
  const states = payload.tasks.map((t) => t.state)
  assert.deepEqual([...new Set(states)].sort(), [...TASK_STATES].sort())
  assert.equal(new Set(states).size, TASK_STATES.length)
})

test("同一 now 两次生成字节级一致", () => {
  assert.equal(JSON.stringify(buildMockTasks({ now: NOW })), JSON.stringify(buildMockTasks({ now: NOW })))
})

test("耗时由 sidecar 算好，与时间戳自洽", () => {
  const payload = buildMockTasks({ now: NOW })
  const done = payload.tasks.find((t) => t.state === "done")
  const expected = new Date(done.endedAt).getTime() - new Date(done.startedAt).getTime()
  assert.equal(done.durationMs, expected)
  for (const task of payload.tasks) assert.ok(Number.isInteger(task.durationMs) && task.durationMs >= 0)
})

test("已完成但没有 endedAt → 拒绝", () => {
  const payload = buildMockTasks({ now: NOW })
  payload.tasks.find((t) => t.state === "done").endedAt = null
  assert.ok(codes(validateTasks(payload)).includes("E_TASK_STATE_TIME"))
})

test("进行中却带 endedAt → 拒绝", () => {
  const payload = buildMockTasks({ now: NOW })
  payload.tasks.find((t) => t.state === "running").endedAt = payload.tasks[2].endedAt
  assert.ok(codes(validateTasks(payload)).includes("E_TASK_STATE_TIME"))
})

test("未知状态 → 拒绝", () => {
  const payload = buildMockTasks({ now: NOW })
  payload.tasks[0].state = "paused"
  assert.ok(codes(validateTasks(payload)).includes("E_TASK_STATE"))
})

test("未知来源标记 → 拒绝（只允许 real / replay）", () => {
  const payload = buildMockTasks({ now: NOW })
  payload.tasks[0].origin = "mock"
  const result = validateTasks(payload)
  assert.ok(codes(result).includes("E_TASK_ORIGIN"))
  assert.deepEqual(TASK_ORIGINS, ["real", "replay"])
})

test("task id 重复 → 拒绝", () => {
  const payload = buildMockTasks({ now: NOW })
  payload.tasks[1].id = payload.tasks[0].id
  assert.ok(codes(validateTasks(payload)).includes("E_TASK_DUP"))
})

test("标题超长 → 拒绝（卡面只放用户原话首句）", () => {
  const payload = buildMockTasks({ now: NOW })
  payload.tasks[0].title = "长".repeat(121)
  assert.ok(codes(validateTasks(payload)).includes("E_TASK_TITLE_LEN"))
})

test("agents 里有空串 → 拒绝", () => {
  const payload = buildMockTasks({ now: NOW })
  payload.tasks[0].agents = [""]
  assert.ok(codes(validateTasks(payload)).includes("E_TASK_AGENTS"))
})

test("没有任务时空数组合法（第一入口的空状态）", () => {
  const payload = { ...buildMockTasks({ now: NOW }), tasks: [] }
  assert.equal(validateTasks(payload).ok, true)
})

test("schemaVersion 不对 → 拒绝", () => {
  const payload = { ...buildMockTasks({ now: NOW }), schemaVersion: 2 }
  assert.ok(codes(validateTasks(payload)).includes("E_SCHEMA_VERSION"))
})

test("assertValidTasks 失败时抛异常并带错误明细", () => {
  const payload = buildMockTasks({ now: NOW })
  payload.tasks[0].state = "paused"
  try {
    assertValidTasks(payload)
    assert.fail("应当抛错")
  } catch (error) {
    assert.ok(error instanceof TasksValidationError)
    assert.ok(error.errors.length > 0)
  }
})
