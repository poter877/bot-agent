/** film-pipeline 契约测试：风格注册表、路由（styles/projects 校验）、DDL、流程定义。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Hono } from 'hono'

const { initSqliteSchema } = await import('../src/db/sqlite-schema.js')
const { filmStyles, filmStyleGroups, getFilmStyle } = await import('../src/services/film-styles.js')
const film = (await import('../src/routes/film.js')).default
const { filmPipelineDefinition } = await import('../src/services/film-pipeline/definitions.js')

test('film DDL creates tables and dramas gains film_style', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'film-ddl-'))
  const db = new Database(path.join(dir, 't.sqlite3'))
  initSqliteSchema(db)
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name)
  for (const t of ['film_projects', 'film_runs', 'film_render_jobs']) assert.ok(tables.includes(t), `${t} missing`)
  const cols = (db.prepare('PRAGMA table_info(dramas)').all() as { name: string }[]).map((c) => c.name)
  assert.ok(cols.includes('film_style'))
})

test('style registry exposes 43 styles with grouped categories and render profiles', () => {
  const styles = filmStyles()
  assert.equal(styles.length, 43)
  const groups = filmStyleGroups()
  assert.equal(groups.reduce((n, g) => n + g.styles.length, 0), 43)
  assert.ok(groups.length >= 8)
  for (const s of styles) {
    assert.ok(s.slug && s.cn && s.en, `style ${s.slug} missing names`)
    assert.ok(['2d', 'shader', '3d'].includes(s.renderProfile))
  }
  const ink = getFilmStyle('ink-wash')!
  assert.equal(ink.cn, '中国水墨')
  assert.ok(getFilmStyle('nope') === null)
})

test('film routes serve styles and validate ids', async () => {
  const groups = await film.request('/styles')
  assert.equal(groups.status, 200)
  const body = (await groups.json()) as { data: unknown[] }
  assert.ok(Array.isArray(body.data) && body.data.length >= 8)

  const flat = await film.request('/styles?flat=1')
  const flatBody = (await flat.json()) as { data: unknown[] }
  assert.equal(flatBody.data.length, 43)

  const one = await film.request('/styles/ink-wash')
  const oneBody = (await one.json()) as { data: { markdown: string } }
  assert.ok(oneBody.data.markdown.includes('## 1.'))

  const bad = await film.request('/styles/nope')
  assert.equal(bad.status, 400)

  for (const p of ['/projects/0/run', '/projects/abc/approve']) {
    const res = await film.request(p, { method: 'POST' })
    assert.equal(res.status, 400)
  }
})

test('film pipeline definition is a single fixed flow with review gates', () => {
  const def = filmPipelineDefinition()
  assert.equal(def.id, 'film')
  assert.deepEqual(
    def.stages.map((s) => s.id),
    ['treatment', 'style_frames', 'script', 'timeline', 'score', 'build', 'render', 'deliver'],
  )
  for (const s of def.stages) assert.ok(s.instruction.length > 20 && s.title)
  const reviewIds = def.stages.filter((s) => s.review).map((s) => s.id)
  assert.deepEqual(reviewIds, ['treatment', 'style_frames', 'script', 'timeline', 'score', 'build'])
})
