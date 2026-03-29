import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const { password } = await request.json();
  const sitePassword = process.env.SITE_PASSWORD;

  if (!sitePassword || password !== sitePassword) {
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set("site_access", password, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    // Cookie lasts 30 days
    maxAge: 60 * 60 * 24 * 30,
  });

  return response;
}
