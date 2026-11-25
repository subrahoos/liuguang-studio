export const AUTH_COOKIE_NAME = "luma_session";
export const AUTH_SESSION_MS = 12 * 60 * 60 * 1000;
export const SERVER_MANAGED_API_KEY = "__server_managed_by_luma__";
export const ADMIN_USERNAME = process.env.LUMA_ADMIN_USERNAME?.trim() || "admin";
export const ADMIN_PASSWORD = process.env.LUMA_ADMIN_PASSWORD?.trim() || "";
export const ADMIN_USER_ID = process.env.LUMA_ADMIN_USER_ID?.trim() || "luma-admin";
export const ADMIN_ACCOUNT_ID = process.env.LUMA_ADMIN_ACCOUNT_ID?.trim() || "LUMA-000001";
