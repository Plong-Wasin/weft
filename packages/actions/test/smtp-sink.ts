/**
 * A local SMTP server for tests: it accepts any message on 127.0.0.1 and keeps it in memory. No mail leaves the machine.
 * It speaks only what nodemailer needs (EHLO, MAIL, RCPT, DATA, RSET, NOOP, QUIT) and no TLS or AUTH.
 */
export interface SinkMessage {
  to: string[];
  /** Decoded subject line. */
  subject: string;
  /** Decoded plain-text body. */
  text: string;
  /** The raw message as received, for header checks. */
  raw: string;
}

export interface SmtpSink {
  port: number;
  messages: SinkMessage[];
  /** Waits until at least `count` messages arrived, or throws after `timeoutMs`. */
  waitFor(count: number, timeoutMs?: number): Promise<SinkMessage[]>;
  close(): void;
}

interface Session {
  buffer: string;
  inData: boolean;
  to: string[];
}

export function startSmtpSink(): SmtpSink {
  const messages: SinkMessage[] = [];
  const server = Bun.listen<Session>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: "", inData: false, to: [] };
        socket.write("220 sink.test ESMTP\r\n");
      },
      data(socket, chunk) {
        const session = socket.data;
        session.buffer += Buffer.from(chunk).toString("utf8");
        for (;;) {
          if (session.inData) {
            const end = session.buffer.indexOf("\r\n.\r\n");
            if (end === -1) return;
            const raw = session.buffer.slice(0, end + 2);
            session.buffer = session.buffer.slice(end + 5);
            session.inData = false;
            messages.push(parseMessage(session.to, raw));
            session.to = [];
            socket.write("250 queued\r\n");
            continue;
          }
          const line = session.buffer.indexOf("\r\n");
          if (line === -1) return;
          const command = session.buffer.slice(0, line);
          session.buffer = session.buffer.slice(line + 2);
          const verb = command.slice(0, 4).toUpperCase();
          if (verb === "EHLO" || verb === "HELO") socket.write("250 sink.test\r\n");
          else if (verb === "MAIL") { session.to = []; socket.write("250 OK\r\n"); }
          else if (verb === "RCPT") { session.to.push(command.replace(/^RCPT TO:\s*/i, "").replace(/[<>]/g, "").trim()); socket.write("250 OK\r\n"); }
          else if (verb === "DATA") { session.inData = true; socket.write("354 End data with <CR><LF>.<CR><LF>\r\n"); }
          else if (verb === "QUIT") { socket.write("221 bye\r\n"); socket.end(); return; }
          else socket.write("250 OK\r\n");
        }
      },
    },
  });
  return {
    port: server.port,
    messages,
    async waitFor(count, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (messages.length < count) {
        if (Date.now() > deadline) throw new Error(`Expected ${count} message(s) at the sink, got ${messages.length}`);
        await Bun.sleep(10);
      }
      return messages;
    },
    close() { server.stop(true); },
  };
}

function parseMessage(to: string[], raw: string): SinkMessage {
  const split = raw.indexOf("\r\n\r\n");
  const headerText = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? "" : raw.slice(split + 4);
  const headers = unfold(headerText);
  const header = (name: string) => headers.find((line) => line.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? "";
  const encoding = header("content-transfer-encoding").toLowerCase();
  return { to, subject: decodeHeader(header("subject")), text: decodeBody(body, encoding), raw };
}

function unfold(headerText: string): string[] {
  const lines: string[] = [];
  for (const line of headerText.split("\r\n")) {
    if (/^[ \t]/.test(line) && lines.length > 0) lines[lines.length - 1] += ` ${line.trim()}`;
    else lines.push(line);
  }
  return lines;
}

/** Decodes RFC 2047 encoded words. Adjacent words are joined before decoding, since one character can be split across them. */
function decodeHeader(value: string): string {
  return value.replace(/(?:=\?UTF-8\?([BQ])\?[^?]*\?=\s*)+/gi, (run) => {
    const words = [...run.matchAll(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi)];
    if (words[0]![1]!.toUpperCase() === "B") return Buffer.from(words.map((word) => word[2]).join(""), "base64").toString("utf8");
    return decodeQuotedPrintable(words.map((word) => word[2]).join("").replace(/_/g, " "));
  });
}

function decodeBody(body: string, encoding: string): string {
  if (encoding === "base64") return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8").replace(/\r\n$/, "");
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body).replace(/\r\n$/, "");
  return body.replace(/\r\n$/, "");
}

function decodeQuotedPrintable(input: string): string {
  const bytes: number[] = [];
  const text = input.replace(/=\r?\n/g, "");
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(index + 1, index + 3))) {
      bytes.push(parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      for (const byte of Buffer.from(char, "utf8")) bytes.push(byte);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
