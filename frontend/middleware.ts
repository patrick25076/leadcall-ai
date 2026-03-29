import { NextRequest, NextResponse } from "next/server";

/**
 * Site-wide password gate.
 * Set SITE_PASSWORD env var on Vercel to enable.
 * Access is stored in a cookie so you only enter it once per browser.
 */
export function middleware(request: NextRequest) {
  const password = process.env.SITE_PASSWORD;

  // No password set = no gate (dev mode)
  if (!password) return NextResponse.next();

  // Don't gate the unlock API route itself
  if (request.nextUrl.pathname === "/api/unlock") return NextResponse.next();

  // Check cookie
  const cookie = request.cookies.get("site_access");
  if (cookie?.value === password) return NextResponse.next();

  // Show password page
  return new NextResponse(passwordPage(), {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}

export const config = {
  matcher: [
    // Match all paths except static files and Next.js internals
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};

function passwordPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GRAI — Access Required</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0f;
      color: #e4e4e7;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      max-width: 400px;
      width: 100%;
      padding: 2rem;
    }
    .logo {
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: 0.15em;
      text-align: center;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, #10b981, #34d399);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      text-align: center;
      color: #71717a;
      font-size: 0.875rem;
      margin-bottom: 2rem;
    }
    .card {
      background: #0d0d14;
      border: 1px solid #27272a;
      border-radius: 12px;
      padding: 2rem;
    }
    label {
      display: block;
      font-size: 0.875rem;
      color: #a1a1aa;
      margin-bottom: 0.5rem;
    }
    input {
      width: 100%;
      padding: 0.75rem 1rem;
      background: #0a0a0f;
      border: 1px solid #3f3f46;
      border-radius: 8px;
      color: #e4e4e7;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus { border-color: #10b981; }
    button {
      width: 100%;
      margin-top: 1rem;
      padding: 0.75rem;
      background: linear-gradient(135deg, #10b981, #059669);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.9; }
    .error {
      color: #f87171;
      font-size: 0.875rem;
      margin-top: 0.75rem;
      text-align: center;
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">GRAI</div>
    <div class="subtitle">Access restricted during development</div>
    <div class="card">
      <form id="form">
        <label for="pw">Password</label>
        <input type="password" id="pw" name="password" placeholder="Enter access password" autocomplete="off" autofocus />
        <button type="submit">Enter</button>
        <div class="error" id="err">Incorrect password</div>
      </form>
    </div>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = document.getElementById('pw').value;
      const res = await fetch('/api/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        window.location.reload();
      } else {
        document.getElementById('err').style.display = 'block';
        document.getElementById('pw').value = '';
        document.getElementById('pw').focus();
      }
    });
  </script>
</body>
</html>`;
}
