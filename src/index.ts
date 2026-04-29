import { connect } from "cloudflare:sockets";

export interface Env {
  PROXY_API_KEY: string;
  MAIL_FROM?: string;
  MAIL_REPLY_TO?: string;
  SMTP_HOST: string;
  SMTP_PORT?: string;
  SMTP_SECURE?: string;
  SMTP_USER: string;
  SMTP_PASS: string;
  ALLOWED_TO_DOMAIN?: string;
}

type SendRequest = {
  from?: string;
  replyTo?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
};

const SEND_PATHS = new Set(["/send", "/v1/send", "/smtp/send"]);

function isLikelyEmail(value: string): boolean {
  // Lightweight check to reject clearly malformed addresses.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeRecipients(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  const single = String(value || "").trim();
  return single ? [single] : [];
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function toBase64(value: string): string {
  return btoa(unescape(encodeURIComponent(value)));
}

function envelopeAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] || value).trim();
}

function escapeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function formatAddressHeader(list: string[] | undefined): string | undefined {
  if (!list?.length) return undefined;
  return list.map(escapeHeader).join(", ");
}

function createMessage(data: SendRequest): string {
  const headers: string[] = [];
  headers.push(`From: ${escapeHeader(data.from || "")}`);
  const toHeader = formatAddressHeader(data.to);
  if (toHeader) headers.push(`To: ${toHeader}`);
  const ccHeader = formatAddressHeader(data.cc);
  if (ccHeader) headers.push(`Cc: ${ccHeader}`);
  if (data.replyTo) headers.push(`Reply-To: ${escapeHeader(data.replyTo)}`);
  headers.push(`Subject: ${escapeHeader(data.subject)}`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  headers.push("MIME-Version: 1.0");

  if (data.text && data.html) {
    const boundary = `boundary_${crypto.randomUUID()}`;
    headers.push(`Content-Type: multipart/alternative; boundary=\"${boundary}\"`);
    const body = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      data.text,
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      data.html,
      `--${boundary}--`,
      "",
    ].join("\r\n");
    return `${headers.join("\r\n")}\r\n\r\n${body}`;
  }

  if (data.html) {
    headers.push("Content-Type: text/html; charset=utf-8");
    return `${headers.join("\r\n")}\r\n\r\n${data.html}\r\n`;
  }

  headers.push("Content-Type: text/plain; charset=utf-8");
  return `${headers.join("\r\n")}\r\n\r\n${data.text || ""}\r\n`;
}

class SmtpClient {
  private socket: Socket;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private encoder = new TextEncoder();
  private readBuffer = "";

  constructor(
    socket: Socket,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {
    this.socket = socket;
    this.reader = reader;
    this.writer = writer;
  }

  static async connect(host: string, port: number, secure: boolean): Promise<SmtpClient> {
    const socket = connect(
      { hostname: host, port },
      { secureTransport: secure ? "on" : "starttls", allowHalfOpen: false },
    );

    const reader = socket.readable.getReader();
    const writer = socket.writable.getWriter();

    return new SmtpClient(socket, reader, writer);
  }

  async startTls(): Promise<void> {
    try {
      this.reader.releaseLock();
    } catch {
      // Ignore release errors.
    }

    try {
      this.writer.releaseLock();
    } catch {
    // Ignore release errors.
    }

    const upgraded = this.socket.startTls();

    this.socket = upgraded;
    this.reader = upgraded.readable.getReader();
    this.writer = upgraded.writable.getWriter();
    this.readBuffer = "";
  }

  async send(command: string): Promise<void> {
    await this.writer.write(this.encoder.encode(`${command}\r\n`));
  }

  async readResponse(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      if (!line) continue;
      lines.push(line);
      if (/^\d{3} /.test(line)) {
        const code = Number(line.slice(0, 3));
        return { code, lines };
      }
    }
  }

  async expect(codes: number[]): Promise<{ code: number; lines: string[] }> {
    const response = await this.readResponse();
    if (!codes.includes(response.code)) {
      throw new Error(`SMTP unexpected response ${response.code}: ${response.lines.join(" | ")}`);
    }
    return response;
  }

  async close(): Promise<void> {
    try {
      await this.writer.close();
    } catch {
      // Ignore close errors.
    }
    try {
      await this.reader.cancel();
    } catch {
      // Ignore cancel errors.
    }
    try {
      this.socket.close();
    } catch {
      // Ignore socket close errors.
    }
  }

  private async readLine(): Promise<string> {
    const decoder = new TextDecoder();

    for (;;) {
      const idx = this.readBuffer.indexOf("\n");
      if (idx >= 0) {
        const line = this.readBuffer.slice(0, idx).replace(/\r$/, "");
        this.readBuffer = this.readBuffer.slice(idx + 1);
        return line;
      }

      const chunk = await this.reader.read();
      if (chunk.done) {
        const remaining = this.readBuffer;
        this.readBuffer = "";
        return remaining;
      }

      this.readBuffer += decoder.decode(chunk.value, { stream: true });
    }
  }
}

async function sendSmtp(data: SendRequest, env: Env): Promise<void> {
  const host = String(env.SMTP_HOST || "").trim();
  const port = Number(String(env.SMTP_PORT || "587").trim());
  const secure = parseBool(env.SMTP_SECURE, false);
  const user = String(env.SMTP_USER || "").trim();
  const pass = String(env.SMTP_PASS || "");

  if (!host || !port || !user || !pass) {
    throw new Error("SMTP is not configured");
  }

  const client = await SmtpClient.connect(host, port, secure);
  const senderEnvelope = envelopeAddress(data.from || "");
  const recipients = [...data.to, ...(data.cc || []), ...(data.bcc || [])];

  try {
    await client.expect([220]);
    await client.send("EHLO mail-proxy");
    await client.expect([250]);

    if (!secure) {
      await client.send("STARTTLS");
      await client.expect([220]);
      await client.startTls();
      await client.send("EHLO mail-proxy");
      await client.expect([250]);
    }

    await client.send("AUTH LOGIN");
    await client.expect([334]);
    await client.send(toBase64(user));
    await client.expect([334]);
    await client.send(toBase64(pass));
    await client.expect([235]);

    await client.send(`MAIL FROM:<${senderEnvelope}>`);
    await client.expect([250]);

    for (const recipient of recipients) {
      await client.send(`RCPT TO:<${recipient}>`);
      await client.expect([250, 251]);
    }

    await client.send("DATA");
    await client.expect([354]);

    const message = createMessage(data).replace(/\r\n\.\r\n/g, "\r\n..\r\n");
    await client.send(`${message}\r\n.`);
    await client.expect([250]);

    await client.send("QUIT");
    await client.expect([221, 250]);
  } finally {
    await client.close();
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function readBearerToken(request: Request): string {
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return request.headers.get("x-proxy-key")?.trim() || "";
}

function parseAndValidate(body: unknown): { ok: true; data: SendRequest } | { ok: false; message: string } {
  if (!body || typeof body !== "object") return { ok: false, message: "Invalid JSON body" };
  const input = body as Record<string, unknown>;
  const from = String(input.from || "").trim();
  const to = normalizeRecipients(input.to);
  const cc = normalizeRecipients(input.cc);
  const bcc = normalizeRecipients(input.bcc);
  const subject = String(input.subject || "").trim();
  const text = String(input.text || "").trim();
  const html = String(input.html || "").trim();
  const replyTo = String(input.replyTo || "").trim();

  if (!to.length) return { ok: false, message: "At least one recipient in to is required" };
  if ([...to, ...cc, ...bcc].some((address) => !isLikelyEmail(address))) {
    return { ok: false, message: "One or more recipient addresses are invalid" };
  }
  if (!subject) return { ok: false, message: "Invalid subject" };
  if (!text && !html) return { ok: false, message: "Either text or html is required" };
  if (replyTo && !isLikelyEmail(replyTo)) return { ok: false, message: "Invalid replyTo" };
  if (from && !isLikelyEmail(envelopeAddress(from))) return { ok: false, message: "Invalid from" };

  return {
    ok: true,
    data: {
      from: from || undefined,
      replyTo: replyTo || undefined,
      to,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      subject,
      text: text || undefined,
      html: html || undefined,
    },
  };
}

function recipientAllowed(to: string[], allowedDomain?: string): boolean {
  const domain = String(allowedDomain || "").trim().toLowerCase();
  if (!domain) return true;
  return to.every((address) => address.toLowerCase().endsWith(`@${domain}`));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "mail-proxy" });
    }

    if (request.method !== "POST" || !SEND_PATHS.has(url.pathname)) {
      return json({ ok: false, code: "not_found" }, 404);
    }

    const token = readBearerToken(request);
    if (!token || token !== env.PROXY_API_KEY) {
      return json({ ok: false, code: "unauthorized" }, 401);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, code: "invalid_json" }, 400);
    }

    const parsed = parseAndValidate(body);
    if (!parsed.ok) {
      return json({ ok: false, code: "validation_error", message: parsed.message }, 400);
    }

    if (!recipientAllowed(parsed.data.to, env.ALLOWED_TO_DOMAIN)) {
      return json({ ok: false, code: "recipient_domain_blocked" }, 403);
    }

    const from = parsed.data.from || String(env.MAIL_FROM || "").trim();
    if (!from || !isLikelyEmail(envelopeAddress(from))) {
      return json({ ok: false, code: "invalid_from", message: "Set a valid from in body.from or MAIL_FROM" }, 400);
    }

    try {
      await sendSmtp(
        {
          ...parsed.data,
          from,
          replyTo: parsed.data.replyTo || String(env.MAIL_REPLY_TO || "").trim() || undefined,
        },
        env,
      );
    } catch (err) {
      return json(
        {
          ok: false,
          code: "smtp_error",
          message: err instanceof Error ? err.message : "SMTP send failed",
        },
        502,
      );
    }

    return json({ ok: true, provider: "smtp", result: { accepted: parsed.data.to.length } });
  },
};
