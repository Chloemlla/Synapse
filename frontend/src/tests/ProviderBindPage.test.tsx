import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProviderBindPage, { readProviderBindSessionToken } from "../components/ProviderBindPage";

const navigate = vi.fn();
const loginWithToken = vi.fn();
const setNotification = vi.fn();
let currentSearchParams = new URLSearchParams();

vi.mock("react-router-dom", () => ({
  Link: ({ children, to, ...props }: any) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
  useSearchParams: () => [currentSearchParams],
}));

vi.mock("../api", () => ({ default: () => "http://localhost:3000" }));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ loginWithToken }),
}));

vi.mock("../components/Notification", () => ({
  useNotification: () => ({ setNotification }),
}));

const bindSession = {
  sessionToken: "fragment-token",
  provider: "linuxdo",
  providerLabel: "Linux.do",
  providerEmail: "someone@example.com",
  providerUsername: "someone",
  avatarUrl: null,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

describe("ProviderBindPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSearchParams = new URLSearchParams();
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("fetch", vi.fn());
  });

  describe("readProviderBindSessionToken", () => {
    it("prefers the query parameter when present", () => {
      window.history.replaceState({}, "", "/auth/provider/bind?sessionToken=from-query#sessionToken=from-hash");
      expect(readProviderBindSessionToken(new URLSearchParams("sessionToken=from-query"))).toBe("from-query");
    });

    it("falls back to the URL fragment (Linux.do redirect contract)", () => {
      window.history.replaceState({}, "", "/auth/provider/bind#sessionToken=from-hash");
      expect(readProviderBindSessionToken(new URLSearchParams(""))).toBe("from-hash");
    });

    it("returns an empty string when neither carries a token", () => {
      window.history.replaceState({}, "", "/auth/provider/bind");
      expect(readProviderBindSessionToken(new URLSearchParams(""))).toBe("");
    });
  });

  it("loads the bind session from the fragment so Linux.do users can finish binding", async () => {
    // 后端 buildProviderBindPageRedirect 把 sessionToken 放 fragment；只读 query 会让
    // Linux.do「未绑定身份」走不到绑定页。
    window.history.replaceState({}, "", "/auth/provider/bind#sessionToken=fragment-token");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, session: bindSession }),
    } as Response);

    render(<ProviderBindPage />);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/auth/provider-bind/session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sessionToken: "fragment-token" }),
      }),
    );

    expect(await screen.findByText(/已有账号邮箱或用户名/)).toBeInTheDocument();
    expect(screen.getAllByText(/someone@example.com/).length).toBeGreaterThan(0);
  });

  it("still loads the session from the query string (Google path / older links)", async () => {
    currentSearchParams = new URLSearchParams("sessionToken=query-token");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, session: { ...bindSession, sessionToken: "query-token" } }),
    } as Response);

    render(<ProviderBindPage />);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/auth/provider-bind/session",
      expect.objectContaining({ body: JSON.stringify({ sessionToken: "query-token" }) }),
    );
  });

  it("shows the retry guidance when the bind session is gone (410)", async () => {
    window.history.replaceState({}, "", "/auth/provider/bind#sessionToken=expired");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 410,
      json: async () => ({ error: "第三方登录绑定会话已过期，请返回登录页重试" }),
    } as Response);

    render(<ProviderBindPage />);

    expect(await screen.findByText(/无法继续绑定/)).toBeInTheDocument();
    expect(screen.getByText(/第三方登录绑定会话已过期/)).toBeInTheDocument();
  });
});
