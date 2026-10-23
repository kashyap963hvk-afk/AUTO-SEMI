import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { createUser, userByToken } from "./store/repo";

/**
 * Local-development authentication (spec section 22): each browser gets an opaque,
 * random 256-bit session token in an httpOnly cookie; the database stores only its
 * SHA-256. Projects are owner-scoped, so one session cannot read another's data.
 * Replace with OIDC for shared deployments.
 */
const COOKIE = "dav_session";

export interface SessionUser {
  id: string;
  display_name: string;
}

export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return userByToken(token);
}

/** Route handlers only: creates a session on first use. */
export async function requireUser(): Promise<SessionUser> {
  const existing = await currentUser();
  if (existing) return existing;
  const token = randomBytes(32).toString("base64url");
  const user = await createUser(token);
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return user;
}
