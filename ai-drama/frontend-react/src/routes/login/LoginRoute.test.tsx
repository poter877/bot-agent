// @vitest-environment jsdom
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { initI18n } from '@/shared/config/i18n'
import { LoginRoute } from './LoginRoute'

vi.mock('@/assets/brand-logo.png', () => ({ default: 'data:image/png;base64,' }))
configure({ asyncUtilTimeout: 5_000 })

function mountLogin() {
  const router = createMemoryRouter([
    { path: '/login', element: <LoginRoute /> },
    { path: '/', element: <div>启动台</div> },
  ], { initialEntries: ['/login'] })
  render(<RouterProvider router={router} />)
}

/** jsdom 不模拟点击 submit 按钮的隐式表单提交：直接派发 submit 事件。 */
function submitForm() {
  fireEvent.submit(document.querySelector('form')!)
}

beforeEach(async () => {
  await initI18n().changeLanguage('zh')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('LoginRoute', () => {
  it('提交登录表单成功后进入应用', async () => {
    const fetchMock = vi.fn(async (_input?: unknown, _init?: RequestInit) => new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    mountLogin()

    fireEvent.change(screen.getByPlaceholderText('you@company.com'), { target: { value: 'ops@company.com' } })
    fireEvent.change(document.querySelector('input[type=\'password\']')!, { target: { value: 'password-123456' } })
    submitForm()

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [callUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(callUrl).toContain('/api/auth/sign-in/email')
    expect(JSON.parse(String(init.body))).toEqual({ email: 'ops@company.com', password: 'password-123456' })
    expect(init.credentials).toBe('include')
    // 成功后无错误提示
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('登录失败展示后端错误信息并停留在登录页', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ code: 401, message: 'Invalid email or password' }), { status: 401, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    mountLogin()

    fireEvent.change(screen.getByPlaceholderText('you@company.com'), { target: { value: 'ops@company.com' } })
    fireEvent.change(document.querySelector('input[type=\'password\']')!, { target: { value: 'wrong-pass' } })
    submitForm()

    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain('Invalid email or password')
    expect(document.querySelector('form')).toBeTruthy()
  })

  it('切换到注册模式提交 sign-up', async () => {
    const fetchMock = vi.fn(async (_input?: unknown, _init?: RequestInit) => new Response(JSON.stringify({ user: { id: 'u2' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    mountLogin()

    fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === '注册')!)
    fireEvent.change(screen.getByPlaceholderText('you@company.com'), { target: { value: 'new@company.com' } })
    fireEvent.change(document.querySelector('input[type=\'password\']')!, { target: { value: 'password-123456' } })
    submitForm()

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/auth/sign-up/email')
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toMatchObject({ email: 'new@company.com', name: 'new' })
  })
})
