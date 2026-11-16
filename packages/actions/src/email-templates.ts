/** Keep in step with `locales` in @weft/shared (actions import nothing from apps, as in locale.ts). */
export type MailLocale = "en" | "th";

/** Plain-text emails in English and Thai. The recipient's saved language wins, then DEFAULT_LANGUAGE, then English. */

export interface RenderedEmail {
  subject: string;
  text: string;
}

const copy = {
  en: {
    verifySubject: "Confirm your email for Weft",
    verifyBody: (url: string) => `Open this link to confirm your email address for Weft:\n\n${url}\n\nThe link works for one hour. If you did not create a Weft account, you can ignore this email.`,
    resetSubject: "Reset your Weft password",
    resetBody: (url: string) => `Someone asked to reset the password for your Weft account. Open this link to choose a new password:\n\n${url}\n\nThe link works once and expires after one hour. If you did not ask for this, ignore this email; your password stays the same.`,
    digestSubject: (count: number) => count === 1 ? "1 new notification in Weft" : `${count} new notifications in Weft`,
    digestIntro: "Here is what happened since your last email:",
    digestFooter: (settingsUrl: string) => `Choose which emails you get: ${settingsUrl}`,
    kind: {
      assignment: (actor: string, item: string) => `${actor} assigned you ${item}`,
      mention: (actor: string, item: string) => `${actor} mentioned you in ${item}`,
      reply: (actor: string, item: string) => `${actor} replied to your comment on ${item}`,
      run_result: (_actor: string, item: string, status: string) => status === "failed" ? `The Agent's run on ${item} failed` : `The Agent finished its run on ${item}`,
    },
    unknownActor: "Someone",
  },
  th: {
    verifySubject: "ยืนยันอีเมลของคุณสำหรับ Weft",
    verifyBody: (url: string) => `เปิดลิงก์นี้เพื่อยืนยันที่อยู่อีเมลของคุณใน Weft:\n\n${url}\n\nลิงก์ใช้ได้ภายในหนึ่งชั่วโมง หากคุณไม่ได้สร้างบัญชี Weft ให้ละเว้นอีเมลนี้`,
    resetSubject: "ตั้งรหัสผ่าน Weft ใหม่",
    resetBody: (url: string) => `มีคนขอตั้งรหัสผ่านใหม่สำหรับบัญชี Weft ของคุณ เปิดลิงก์นี้เพื่อเลือกรหัสผ่านใหม่:\n\n${url}\n\nลิงก์ใช้ได้เพียงครั้งเดียวและหมดอายุใน 1 ชั่วโมง หากคุณไม่ได้ขอ ให้ละเว้นอีเมลนี้ รหัสผ่านของคุณจะไม่เปลี่ยน`,
    digestSubject: (count: number) => `มีการแจ้งเตือนใหม่ ${count} รายการใน Weft`,
    digestIntro: "สิ่งที่เกิดขึ้นตั้งแต่อีเมลฉบับก่อนหน้า:",
    digestFooter: (settingsUrl: string) => `เลือกอีเมลที่ต้องการรับได้ที่: ${settingsUrl}`,
    kind: {
      assignment: (actor: string, item: string) => `${actor} มอบหมาย ${item} ให้คุณ`,
      mention: (actor: string, item: string) => `${actor} กล่าวถึงคุณใน ${item}`,
      reply: (actor: string, item: string) => `${actor} ตอบกลับความคิดเห็นของคุณใน ${item}`,
      run_result: (_actor: string, item: string, status: string) => status === "failed" ? `การทำงานของ Agent กับ ${item} ไม่สำเร็จ` : `Agent ทำงานกับ ${item} เสร็จแล้ว`,
    },
    unknownActor: "มีคน",
  },
} as const;

export function verificationEmail(locale: MailLocale, url: string): RenderedEmail {
  return { subject: copy[locale].verifySubject, text: copy[locale].verifyBody(url) };
}

export function resetPasswordEmail(locale: MailLocale, url: string): RenderedEmail {
  return { subject: copy[locale].resetSubject, text: copy[locale].resetBody(url) };
}

export interface DigestItem {
  kind: "assignment" | "mention" | "reply" | "run_result";
  actorName: string | null;
  /** The work item's key and title, or the Wiki page title. */
  target: string;
  /** Used by run_result: "completed" or "failed". */
  status?: string;
  url: string;
}

/** One email per recipient per digest. It names the event and the item only: never comment text, tokens or other private content. */
export function digestEmail(locale: MailLocale, items: DigestItem[], settingsUrl: string): RenderedEmail {
  const strings = copy[locale];
  const lines = items.map((item) => {
    const actor = item.actorName ?? strings.unknownActor;
    const sentence = strings.kind[item.kind](actor, item.target, item.status ?? "completed");
    return `- ${sentence}\n  ${item.url}`;
  });
  return {
    subject: strings.digestSubject(items.length),
    text: `${strings.digestIntro}\n\n${lines.join("\n")}\n\n${strings.digestFooter(settingsUrl)}`,
  };
}
