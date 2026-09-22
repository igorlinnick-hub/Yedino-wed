// POST /api/lead — the quiz on the landing posts here.
//
// No dependencies on purpose: the site repo stays a static project with one
// function next to it. Mail goes out over Gmail SMTP with an app password,
// spoken by hand over a TLS socket.
//
// Env (Vercel project `yedinowed`, Production):
//   YEDINO_GMAIL_ADDRESS       the mailbox we authenticate as
//   YEDINO_GMAIL_APP_PASSWORD  16-char app password, spaces allowed
//   LEAD_NOTIFY_TO             comma-separated recipients for the notification

import tls from "node:tls";

const HOST = "smtp.gmail.com";
const PORT = 465;

/** Speak SMTP: connect, authenticate, send one message, hang up. */
export function sendMail({ user, pass, from, to, subject, text, replyTo }) {
  return new Promise((resolve, reject) => {
    const recipients = to.filter(Boolean);
    if (!recipients.length) return reject(new Error("no recipients"));

    const body = [
      `From: Yedino Systems <${from}>`,
      `To: ${recipients.join(", ")}`,
      replyTo ? `Reply-To: ${replyTo}` : null,
      `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
    ]
      .filter((l) => l !== null)
      .join("\r\n");

    const steps = [
      { expect: 220, send: `EHLO yedinosystems.com` },
      { expect: 250, send: "AUTH LOGIN" },
      { expect: 334, send: Buffer.from(user, "utf8").toString("base64") },
      { expect: 334, send: Buffer.from(pass, "utf8").toString("base64") },
      { expect: 235, send: `MAIL FROM:<${from}>` },
      ...recipients.map((r) => ({ expect: 250, send: `RCPT TO:<${r}>` })),
      { expect: 250, send: "DATA" },
      { expect: 354, send: `${body}\r\n.` },
      { expect: 250, send: "QUIT" },
    ];

    let i = 0;
    let buffer = "";
    let done = false;
    const socket = tls.connect({ host: HOST, port: PORT, servername: HOST });
    socket.setTimeout(20000);

    const fail = (err) => {
      if (done) return;
      done = true;
      socket.destroy();
      reject(err);
    };

    socket.on("timeout", () => fail(new Error("smtp timeout")));
    socket.on("error", fail);

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      // A reply is complete when its last line reads "250 text", not "250-text".
      const lines = buffer.split("\r\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3} /.test(last)) return;
      buffer = "";

      const code = Number(last.slice(0, 3));
      const step = steps[i];
      if (!step) return;
      if (code !== step.expect) return fail(new Error(`smtp ${code}: ${last}`));

      i += 1;
      if (step.send === "QUIT") {
        done = true;
        socket.end();
        return resolve(true);
      }
      socket.write(`${step.send}\r\n`);
    });
  });
}

const clean = (v, max = 200) =>
  typeof v === "string" ? v.replace(/[\r\n]+/g, " ").trim().slice(0, max) : "";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method" });
  }

  let payload = req.body;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return res.status(400).json({ ok: false, error: "bad json" });
    }
  }
  payload = payload || {};

  // Honeypot: a real person never fills a field they cannot see.
  if (clean(payload.company)) return res.status(200).json({ ok: true });
  // Nor do they finish the quiz in under three seconds.
  const elapsed = Number(payload.elapsed || 0);
  if (elapsed && elapsed < 3000) return res.status(200).json({ ok: true });

  const lead = {
    name: [clean(payload.first, 60), clean(payload.last, 60)].filter(Boolean).join(" "),
    instagram: clean(payload.instagram, 80).replace(/^@/, ""),
    email: clean(payload.email, 120),
    phone: clean(payload.phone, 40),
    city: clean(payload.city, 120),
    about: clean(payload.about, 600),
    treats: clean(payload.treats, 60),
    pays: clean(payload.pays, 60),
    spend: clean(payload.spend, 60),
    start: clean(payload.start, 60),
    source: clean(payload.source, 200),
    page: clean(payload.page, 200),
    at: new Date().toISOString(),
  };

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lead.email)) {
    return res.status(400).json({ ok: false, error: "email" });
  }
  if (!lead.instagram && !lead.city) {
    return res.status(400).json({ ok: false, error: "clinic" });
  }

  const user = process.env.YEDINO_GMAIL_ADDRESS;
  const pass = (process.env.YEDINO_GMAIL_APP_PASSWORD || "").replace(/\s/g, "");
  const to = (process.env.LEAD_NOTIFY_TO || user || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const text = [
    `${lead.name || "—"} · @${lead.instagram || "—"}`,
    "",
    `Email:      ${lead.email}`,
    `Phone:      ${lead.phone || "—"}`,
    `City:       ${lead.city || "—"}`,
    "",
    `Treats:     ${lead.treats || "—"}`,
    `Pays:       ${lead.pays || "—"}`,
    `Spend:      ${lead.spend || "—"}`,
    `Can start:  ${lead.start || "—"}`,
    "",
    lead.about ? `About:\n${lead.about}\n` : "",
    `Source:     ${lead.source || "direct"}`,
    `Page:       ${lead.page || "—"}`,
    `At:         ${lead.at}`,
  ].join("\n");

  // The lead is in the log whatever happens to the mail.
  console.log("LEAD", JSON.stringify(lead));

  if (!user || !pass || !to.length) {
    console.error("MAIL SKIPPED", { user: !!user, pass: !!pass, to: to.length });
    return res.status(200).json({ ok: true, mailed: false });
  }

  try {
    await sendMail({
      user,
      pass,
      from: user,
      to,
      replyTo: lead.email,
      subject: `Lead · ${lead.name || "clinic"} · @${lead.instagram || lead.city || "—"} · ${lead.treats || "—"}`,
      text,
    });
    return res.status(200).json({ ok: true, mailed: true });
  } catch (err) {
    console.error("MAIL FAILED", err.message);
    return res.status(200).json({ ok: true, mailed: false });
  }
}
